// Runs on Node's built-in test runner: `node --test`. Uses WebCrypto (global
// in Node 20+) and a fake KV + fetch, so no wrangler/miniflare needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _internal } from '../src/worker.js';

function fakeKV() {
  const m = new Map();
  return {
    m,
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async delete(k) { m.delete(k); },
  };
}

function env(over = {}) {
  return {
    CF_APP_ID: 'app123',
    CF_APP_SECRET: 'sekret',
    SIGN_KEY: 'signing-key',
    DEVICE_TOKEN: 'device-tok',
    SESSIONS: fakeKV(),
    ...over,
  };
}

async function signedQuery(e, camera, ttl = 60) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await _internal.sign(e.SIGN_KEY, camera + '\n' + exp);
  return `?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

test('PUT /session requires the device token', async () => {
  const e = env();
  const bad = await worker.fetch(new Request('https://w/session/cam', {
    method: 'PUT', headers: { Authorization: 'Bearer wrong' },
    body: JSON.stringify({ appId: 'app123', sessionId: 'pub1' }),
  }), e);
  assert.equal(bad.status, 401);

  const ok = await worker.fetch(new Request('https://w/session/cam', {
    method: 'PUT', headers: { Authorization: 'Bearer device-tok' },
    body: JSON.stringify({ appId: 'app123', sessionId: 'pub1', track: 'video' }),
  }), e);
  assert.equal(ok.status, 200);
  assert.ok(await e.SESSIONS.get('cam:cam'));
});

test('watch page is gated by a valid signature', async () => {
  const e = env();
  const denied = await worker.fetch(new Request('https://w/watch/cam?exp=1&sig=nope'), e);
  assert.equal(denied.status, 403);

  const q = await signedQuery(e, 'cam');
  const ok = await worker.fetch(new Request('https://w/watch/cam' + q), e);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /RTCPeerConnection/);
});

test('expired signature is rejected', async () => {
  const e = env();
  const exp = Math.floor(Date.now() / 1000) - 10;
  const sig = await _internal.sign(e.SIGN_KEY, 'cam\n' + exp);
  const res = await worker.fetch(new Request(`https://w/watch/cam?exp=${exp}&sig=${sig}`), e);
  assert.equal(res.status, 403);
});

test('WHEP bridges offer->answer via Cloudflare and returns the answer SDP', async () => {
  const e = env();
  await e.SESSIONS.put('cam:cam', JSON.stringify({ appId: 'app123', sessionId: 'pub-sess', track: 'video' }));

  const calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push({ u: String(u), body: init && init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (String(u).endsWith('/sessions/new')) return new Response(JSON.stringify({ sessionId: 'sub-sess' }));
    return new Response(JSON.stringify({ sessionDescription: { type: 'answer', sdp: 'v=0\nanswer' } }));
  };

  const q = await signedQuery(e, 'cam');
  const res = await worker.fetch(new Request('https://w/whep/cam' + q, {
    method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\noffer',
  }), e);

  assert.equal(res.status, 201);
  assert.equal((await res.text()).trim(), 'v=0\nanswer');
  assert.equal(res.headers.get('Content-Type'), 'application/sdp');
  // subscriber pulls the *publisher's* session id as a remote track
  const pull = calls.find((c) => c.u.includes('/tracks/new'));
  assert.equal(pull.body.tracks[0].sessionId, 'pub-sess');
  assert.equal(pull.body.tracks[0].location, 'remote');
  assert.equal(pull.auth, 'Bearer sekret'); // falls back to env.CF_APP_SECRET when the record has none
});

test('WHEP uses the device-supplied secret from KV over env.CF_APP_SECRET', async () => {
  const e = env({ CF_APP_SECRET: 'env-fallback' });
  await e.SESSIONS.put('cam:cam', JSON.stringify({ appId: 'app123', sessionId: 'pub-sess', track: 'video', secret: 'device-secret' }));

  let auth = null;
  globalThis.fetch = async (u, init) => {
    auth = init.headers.Authorization;
    if (String(u).endsWith('/sessions/new')) return new Response(JSON.stringify({ sessionId: 'sub-sess' }));
    return new Response(JSON.stringify({ sessionDescription: { type: 'answer', sdp: 'v=0\nanswer' } }));
  };

  const q = await signedQuery(e, 'cam');
  await worker.fetch(new Request('https://w/whep/cam' + q, { method: 'POST', body: 'v=0\noffer' }), e);
  assert.equal(auth, 'Bearer device-secret');
});

test('PUT /session stores a device-supplied secret', async () => {
  const e = env();
  await worker.fetch(new Request('https://w/session/cam', {
    method: 'PUT', headers: { Authorization: 'Bearer device-tok' },
    body: JSON.stringify({ appId: 'app123', sessionId: 'pub1', track: 'video', secret: 's3cr3t' }),
  }), e);
  const rec = JSON.parse(await e.SESSIONS.get('cam:cam'));
  assert.equal(rec.secret, 's3cr3t');
});

test('WHEP is 409 when the camera is not publishing', async () => {
  const e = env();
  const q = await signedQuery(e, 'cam');
  const res = await worker.fetch(new Request('https://w/whep/cam' + q, { method: 'POST', body: 'v=0\noffer' }), e);
  assert.equal(res.status, 409);
});

test('stripH265 drops H265 payloads and their rtx/fmtp lines, keeps H264', () => {
  const sdp = [
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
    'a=rtpmap:96 H264/90000',
    'a=rtpmap:98 H265/90000',
    'a=fmtp:99 apt=98',
    'a=rtpmap:99 rtx/90000',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
  ].join('\n');
  const out = _internal.stripH265(sdp);
  assert.doesNotMatch(out, /H265/);
  assert.match(out, /H264/);
  assert.match(out.split('\n')[0], /^m=video 9 UDP\/TLS\/RTP\/SAVPF 96 97$/);
});
