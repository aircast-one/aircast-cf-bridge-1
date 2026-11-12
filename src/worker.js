// Public WHEP viewer for cameras published to Cloudflare Realtime.
//
// Cloudflare Realtime has no public playback: pulling a track needs the app
// secret and the live publisher session id. This Worker holds the secret and
// reads the session id from KV (the device reports it on every publish), then
// bridges a standard WHEP handshake to Cloudflare's Sessions API. The media
// still flows viewer <-> Cloudflare edge; the Worker only brokers signalling.
//
// Nothing here touches aircast-api: publish, signalling and media all live on
// Cloudflare, so a viewer keeps working even when the backend is down. Access
// is gated at the edge by an HMAC-signed link the device mints — an offline
// check that also survives the backend being down.
//
// Routes:
//   PUT    /session/:camera        device -> store {appId, sessionId, track, secret}  (Bearer DEVICE_TOKEN)
//   DELETE /session/:camera        device -> clear                             (Bearer DEVICE_TOKEN)
//   GET    /watch/:camera?exp&sig  viewer -> minimal HTML player               (signed)
//   POST   /whep/:camera?exp&sig   viewer -> WHEP offer/answer bridge          (signed)
//   OPTIONS *                      CORS preflight

import { STYLES } from './styles.js';

const CF_API = 'https://rtc.live.cloudflare.com/v1/apps/';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method;

  if (method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

  // Tailwind CSS bundled from aircastd, so the player looks identical.
  if (parts[0] === 'assets' && parts[1] === 'output.css' && method === 'GET') {
    return new Response(STYLES, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }

  // /session/:camera
  if (parts[0] === 'session' && parts.length === 2) {
    if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
    const camera = decodeURIComponent(parts[1]);
    if (method === 'PUT') return putSession(request, env, camera);
    if (method === 'DELETE') { await env.SESSIONS.delete(kvKey(camera)); return json({ ok: true }); }
    return json({ error: 'method not allowed' }, 405);
  }

  // /watch/:camera
  if (parts[0] === 'watch' && parts.length === 2 && method === 'GET') {
    const camera = decodeURIComponent(parts[1]);
    if (!(await verify(env, camera, url.searchParams))) return html(deniedPage(), 403);
    return html(playerPage());
  }

  // /whep/:camera  and  /whep/:camera/:session (delete)
  if (parts[0] === 'whep' && (parts.length === 2 || parts.length === 3)) {
    const camera = decodeURIComponent(parts[1]);
    if (method === 'POST' && parts.length === 2) {
      if (!(await verify(env, camera, url.searchParams))) return cors(json({ error: 'forbidden' }, 403));
      return whep(request, env, camera);
    }
    // WHEP resource teardown is a no-op for a pull session; Cloudflare reaps it.
    if (method === 'DELETE') return cors(new Response(null, { status: 200 }));
    return cors(json({ error: 'method not allowed' }, 405));
  }

  return json({ error: 'not found' }, 404);
}

function kvKey(camera) { return 'cam:' + camera; }

function authed(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.DEVICE_TOKEN && timingEqual(token, env.DEVICE_TOKEN);
}

async function putSession(request, env, camera) {
  const body = await request.json().catch(() => null);
  if (!body || !body.appId || !body.sessionId) return json({ error: 'need appId and sessionId' }, 400);
  const rec = {
    appId: String(body.appId),
    sessionId: String(body.sessionId),
    track: String(body.track || 'video'),
    at: Math.floor(Date.now() / 1000),
  };
  // The device sends its Cloudflare app secret so the operator never sets it as
  // a Worker secret — one fewer thing to paste at deploy. Falls back to
  // env.CF_APP_SECRET for a manual setup.
  if (body.secret) rec.secret = String(body.secret);
  // Publisher sessions go stale when the drone reconnects; a TTL keeps a dead
  // session id from lingering and serving a black stream forever.
  await env.SESSIONS.put(kvKey(camera), JSON.stringify(rec), { expirationTtl: 300 });
  return json({ ok: true });
}

async function whep(request, env, camera) {
  const offer = await request.text();
  if (!offer) return cors(json({ error: 'empty offer' }, 400));
  const raw = await env.SESSIONS.get(kvKey(camera));
  if (!raw) return cors(json({ error: 'camera not publishing' }, 409));
  const rec = JSON.parse(raw);
  const secret = rec.secret || env.CF_APP_SECRET;
  if (!secret) return cors(json({ error: 'no Cloudflare app secret available' }, 500));

  const sub = await cfCall(rec.appId, secret, 'sessions/new');
  if (!sub.sessionId) return cors(json({ error: 'cloudflare: new session failed', detail: sub.errorDescription || '' }, 502));

  const pull = await cfCall(rec.appId, secret, `sessions/${sub.sessionId}/tracks/new`, {
    sessionDescription: { type: 'offer', sdp: stripH265(offer) },
    tracks: [{ location: 'remote', sessionId: rec.sessionId, trackName: rec.track }],
  });
  const sd = pull.sessionDescription;
  if (!sd || sd.type !== 'answer' || !sd.sdp) {
    const detail = (pull.tracks && pull.tracks[0] && pull.tracks[0].errorDescription) || pull.errorDescription || '';
    return cors(json({ error: 'cloudflare: pull track failed', detail }, 502));
  }
  return cors(new Response(sd.sdp, {
    status: 201,
    headers: {
      'Content-Type': 'application/sdp',
      'Location': `/whep/${encodeURIComponent(camera)}/${sub.sessionId}`,
    },
  }));
}

async function cfCall(appId, secret, path, body) {
  const res = await fetch(CF_API + encodeURIComponent(appId) + '/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Cloudflare rejects the whole offer if an m-line advertises a codec it can't
// pull (H265/HEVC, which QGC/GStreamer players offer). Drop those payloads. A
// browser player page never offers H265, so this only matters for third-party
// WHEP clients.
function stripH265(sdp) {
  const drop = new Set();
  for (const line of sdp.split('\n')) {
    const m = line.match(/^a=rtpmap:(\d+)\s+([^/]+)\//i);
    if (m && /^(h265|hevc)$/i.test(m[2])) drop.add(m[1]);
  }
  if (drop.size === 0) return sdp;
  for (const line of sdp.split('\n')) {
    const m = line.match(/^a=fmtp:(\d+)\s+.*apt=(\d+)/i);
    if (m && drop.has(m[2])) drop.add(m[1]);
  }
  return sdp
    .split('\n')
    .map((line) => {
      if (line.startsWith('m=video ')) {
        const f = line.trim().split(/\s+/);
        return [...f.slice(0, 3), ...f.slice(3).filter((pt) => !drop.has(pt))].join(' ');
      }
      return line;
    })
    .filter((line) => {
      const m = line.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/);
      return !(m && drop.has(m[2]));
    })
    .join('\n');
}

// --- signed-link verification (offline, no backend call) ---

async function verify(env, camera, params) {
  const exp = params.get('exp');
  const sig = params.get('sig');
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(env.SIGN_KEY, camera + '\n' + exp);
  return timingEqual(expected, sig);
}

async function sign(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return b64url(new Uint8Array(mac));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// --- responses ---

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.headers.set('Access-Control-Expose-Headers', 'Location');
  return res;
}

function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function deniedPage() {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Live stream · Aircast</title>
<body style="margin:0;height:100vh;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:rgba(255,255,255,.8);font:14px/1.4 system-ui,sans-serif;text-align:center;padding:24px">
<svg viewBox="0 0 24 24" width=32 height=32 fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1=2 x2=22 y1=2 y2=22/></svg>
<p>This link is invalid, expired, or has been revoked.</p>`;
}

// playerPage ports aircastd's own /watch player (internal/web/templates/watch.templ):
// a full-screen viewer with auto-hiding top/bottom chrome, play/pause, mute,
// fullscreen and live stats, plus card overlays for connecting/error states —
// using the same Tailwind theme (served at /assets/output.css). Device-only bits
// (telemetry HUD, HLS fallback, /diagnose, back-to-/streaming) are dropped, and
// the WHEP handshake targets this Worker's signed /whep endpoint. The one
// Cloudflare-specific tweak: build the MediaStream from the track, since
// Cloudflare's answer doesn't populate e.streams[0].
function playerPage() {
  return `<!DOCTYPE html><html lang=en class=dark><head>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Live stream · Aircast</title><link rel=stylesheet href="/assets/output.css">
</head><body class="m-0 h-screen overflow-hidden bg-background font-sans text-foreground antialiased">
<div id=stage class="fixed inset-0">
<video id=v autoplay playsinline muted class="h-full w-full bg-background object-contain"></video>
<div data-chrome class="absolute inset-x-0 top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-background/60 to-transparent px-4 py-3 transition-opacity duration-200">
<span id=camname class="text-sm font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.6)]"></span>
<span id=live class="ml-auto hidden items-center gap-1.5 rounded-full border border-destructive/25 bg-card/70 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-destructive backdrop-blur">
<span class="h-1.5 w-1.5 rounded-full bg-destructive"></span>Live</span>
</div>
<div id=overlay class="absolute inset-0 z-20 grid place-items-center transition-opacity duration-300"><div id=card></div></div>
<div data-chrome class="absolute inset-x-0 bottom-0 z-30 flex items-center gap-1 bg-gradient-to-t from-background/60 to-transparent px-4 py-3 transition-opacity duration-200">
<button id=playpause aria-label=Pause class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent">
<span data-ic-play class=hidden><svg class="h-5 w-5" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
<span data-ic-pause><svg class="h-5 w-5" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><rect x=14 y=4 width=4 height=16 rx=1/><rect x=6 y=4 width=4 height=16 rx=1/></svg></span></button>
<button id=mute aria-label=Unmute class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent">
<span data-ic-vol class=hidden><svg class="h-5 w-5" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg></span>
<span data-ic-muted><svg class="h-5 w-5" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1=22 x2=16 y1=9 y2=15/><line x1=16 x2=22 y1=9 y2=15/></svg></span></button>
<span id=stats class="ml-1.5 text-xs tabular-nums text-muted-foreground"></span>
<span class=flex-1></span>
<button id=fs aria-label=Fullscreen class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-accent">
<svg class="h-5 w-5" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
</div></div>
<script>
(function(){
"use strict";
var ICE_MS=3000,RETRY_MIN=1500,RETRY_MAX=15000,POLL_MS=1000,STALL_TICKS=3,IDLE_MS=2800;
var cam=location.pathname.split("/").filter(Boolean).pop()||"";
var whepURL="/whep/"+encodeURIComponent(cam)+location.search;
var $=function(id){return document.getElementById(id)};
var stage=$("stage"),video=$("v"),overlay=$("overlay"),card=$("card"),live=$("live"),stats=$("stats");
$("camname").textContent=cam;
var pc=null,retrying=false,backoff=RETRY_MIN,lastDecoded=-1,stall=0,codecMime="";
function esc(s){var d=document.createElement("span");d.textContent=s==null?"":String(s);return d.innerHTML}
function showState(kind,title,hint,actions){
overlay.classList.remove("opacity-0","pointer-events-none");live.classList.add("hidden");
var variant=kind==="err"?"border-destructive/25 bg-destructive/10 text-destructive":kind==="warn"?"border-warning/25 bg-warning/10 text-warning":"border-border bg-card text-card-foreground";
card.className="min-w-[220px] max-w-[min(88vw,420px)] rounded-2xl border p-6 text-center shadow-2xl backdrop-blur "+variant;
var glyph=kind==="loading"?'<div class="mx-auto mb-3.5 h-10 w-10 animate-spin rounded-full border-[3px] border-foreground/15 border-t-foreground"></div>':'<div class="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-full text-[22px] font-bold '+(kind==="err"?"bg-destructive/15":"bg-warning/15")+'">'+(kind==="err"?"✕":"⚠")+"</div>";
var acts=(actions||[]).map(function(a,i){return '<button data-act="'+i+'" class="cursor-pointer rounded-lg border border-border bg-foreground/5 px-3.5 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-foreground/10">'+esc(a.label)+"</button>"}).join("");
card.innerHTML=glyph+'<div class="text-base font-semibold text-foreground">'+esc(title)+"</div>"+(hint?'<div class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">'+esc(hint)+"</div>":"")+(acts?'<div class="mt-4 flex justify-center gap-2">'+acts+"</div>":"");
(actions||[]).forEach(function(a,i){var b=card.querySelector('[data-act="'+i+'"]');if(b)b.onclick=a.onClick});
}
function showLive(){overlay.classList.add("opacity-0","pointer-events-none");live.classList.remove("hidden")}
video.addEventListener("error",function(){showState("err","Playback error","The browser couldn’t play this stream.",[{label:"Retry",onClick:hardRetry}])});
async function start(){
lastDecoded=-1;stall=0;codecMime="";
showState("loading","Connecting…","Reaching "+cam);
pc=new RTCPeerConnection();
pc.addTransceiver("video",{direction:"recvonly"});
var ms=new MediaStream();
pc.ontrack=function(e){try{e.receiver.playoutDelayHint=0.15}catch(_){}; ms.addTrack(e.track); video.srcObject=ms};
pc.oniceconnectionstatechange=function(){var s=pc.iceConnectionState;if(s==="connected"||s==="completed")backoff=RETRY_MIN;else if(s==="failed"){showState("err","Connection failed","Couldn’t reach the camera. Reconnecting…");retry()}else if(s==="disconnected"){showState("loading","Reconnecting…","The connection dropped.");retry()}};
await pc.setLocalDescription(await pc.createOffer());
await new Promise(function(res){if(pc.iceGatheringState==="complete")return res();var t=setTimeout(res,ICE_MS);pc.addEventListener("icegatheringstatechange",function(){if(pc.iceGatheringState==="complete"){clearTimeout(t);res()}})});
showState("loading","Starting stream…","");
var resp;
try{resp=await fetch(whepURL,{method:"POST",headers:{"Content-Type":"application/sdp"},body:pc.localDescription.sdp})}
catch(_){showState("err","Bridge unreachable","Couldn’t reach the video service. Retrying…");return retry()}
if(resp.status===403)return showState("err","Link invalid","This link is invalid, expired, or has been revoked.");
if(resp.status===409){showState("warn","Stream offline","The camera isn’t publishing right now.",[{label:"Try again",onClick:hardRetry}]);return retry()}
if(!resp.ok){showState("warn","Server error "+resp.status,"The bridge rejected the request. Retrying…");return retry()}
await pc.setRemoteDescription({type:"answer",sdp:await resp.text()});
}
function retry(){if(retrying)return;retrying=true;try{pc&&pc.close()}catch(_){}
var wait=backoff;backoff=Math.min(backoff*2,RETRY_MAX);setTimeout(function(){retrying=false;start().catch(retry)},wait)}
function hardRetry(){backoff=RETRY_MIN;try{pc&&pc.close()}catch(_){}retrying=false;start().catch(retry)}
setInterval(async function(){
if(!pc||pc.connectionState!=="connected")return;
var st=await pc.getStats(),inbound=null;st.forEach(function(s){if(s.type==="inbound-rtp"&&s.kind==="video")inbound=s});
if(!inbound)return;
if(inbound.codecId){var c=st.get(inbound.codecId);if(c&&c.mimeType)codecMime=c.mimeType}
var decoded=inbound.framesDecoded||0,packets=inbound.packetsReceived||0,recv=inbound.framesReceived||0;
if(decoded>lastDecoded){lastDecoded=decoded;stall=0;
var jb=inbound.jitterBufferEmittedCount>0?(inbound.jitterBufferDelay/inbound.jitterBufferEmittedCount)*1000:null;
stats.textContent=(jb==null?"":Math.round(jb)+" ms · ")+Math.round(inbound.framesPerSecond||0)+" fps"+(inbound.frameHeight?" · "+inbound.frameHeight+"p":"");
showLive();return}
lastDecoded=decoded;stall++;if(stall<STALL_TICKS)return;
if(packets===0)showState("warn","Waiting for video","Connected but no packets yet…");
else if(recv===0)showState("warn","Can’t read the video","Receiving data but no complete frames — likely a codec this browser can’t assemble.");
else showState("warn","Can’t decode "+(codecMime||"this codec").replace("video/",""),"Receiving frames the browser can’t decode.");
},POLL_MS);
var pp=$("playpause");function syncPP(){pp.setAttribute("aria-label",video.paused?"Play":"Pause");pp.querySelector("[data-ic-play]").classList.toggle("hidden",!video.paused);pp.querySelector("[data-ic-pause]").classList.toggle("hidden",video.paused)}
pp.onclick=function(){video.paused?video.play():video.pause()};video.addEventListener("play",syncPP);video.addEventListener("pause",syncPP);
var mute=$("mute");function syncMute(){mute.setAttribute("aria-label",video.muted?"Unmute":"Mute");mute.querySelector("[data-ic-vol]").classList.toggle("hidden",video.muted);mute.querySelector("[data-ic-muted]").classList.toggle("hidden",!video.muted)}
mute.onclick=function(){video.muted=!video.muted;syncMute()};
$("fs").onclick=function(){document.fullscreenElement?document.exitFullscreen():stage.requestFullscreen()};video.addEventListener("dblclick",$("fs").onclick);
var chrome=document.querySelectorAll("[data-chrome]"),idleT;
function setChrome(h){chrome.forEach(function(c){c.classList.toggle("opacity-0",h);c.classList.toggle("pointer-events-none",h)})}
function activity(){setChrome(false);clearTimeout(idleT);idleT=setTimeout(function(){if(!video.paused)setChrome(true)},IDLE_MS)}
["mousemove","touchstart","click","keydown"].forEach(function(ev){stage.addEventListener(ev,activity)});activity();
start().catch(retry);
})();
</script></body></html>`;
}

// Exported for unit tests (Node import); ignored by the Workers runtime.
export const _internal = { stripH265, sign, verify, timingEqual, b64url };
