# aircast-cf-bridge

A Cloudflare Worker that gives a **public, no-login browser viewer** for cameras
published to Cloudflare Realtime — and keeps working when `aircast-api` is down.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aircast-one/aircast-cf-bridge)

One-click deploy into **your own** Cloudflare account. The deploy flow prompts
for the **two keys** your device shows (Settings → Public viewer) — that's the
whole setup. Your Cloudflare app secret is sent by the device automatically, so
you never paste it. The device UI walks you through it.

## Why

Cloudflare Realtime has no public playback: pulling a track needs the app secret
and the live publisher session id. This Worker holds the secret and reads the
session id from KV (the device reports it on each publish), then bridges a
standard WHEP handshake to Cloudflare. Media flows viewer ↔ Cloudflare edge; the
Worker only brokers signalling.

Nothing in the path touches `aircast-api` — publish, signalling and media all
live on Cloudflare. Access is gated by an **HMAC-signed link** the device mints,
verified at the edge, so gating also survives the backend being down.

```
device ──publish──▶ Cloudflare Realtime
   │  reports sessionId (Bearer DEVICE_TOKEN)
   ▼
 Worker KV ◀── Worker ──WHEP bridge──▶ Cloudflare
                  ▲
viewer ──signed /watch link──┘   (media: viewer ↔ Cloudflare edge)
```

## Routes

| Method | Path | Who | Auth |
|--------|------|-----|------|
| `PUT` | `/session/:camera` | device reports `{appId, sessionId, track}` | `Bearer DEVICE_TOKEN` |
| `DELETE` | `/session/:camera` | device clears on unpublish | `Bearer DEVICE_TOKEN` |
| `GET` | `/watch/:camera?exp&sig` | viewer — HTML player | signed link |
| `POST` | `/whep/:camera?exp&sig` | viewer — WHEP offer/answer | signed link |

## Deploy

```sh
npm install
npx wrangler kv namespace create SESSIONS   # paste the id into wrangler.toml
npx wrangler secret put CF_APP_SECRET        # Cloudflare Realtime app secret
npx wrangler secret put SIGN_KEY             # shared with the device
npx wrangler secret put DEVICE_TOKEN         # shared with the device
npx wrangler deploy
```

Point the device (Settings → Video streaming) at the deployed URL and the same
`SIGN_KEY` / `DEVICE_TOKEN`. The device then reports session ids and mints
`/watch/:camera?exp&sig` links for the overview page.

BYO-infra: deploy this in the same Cloudflare account that owns the Realtime app.

## Test

```sh
npm test    # node --test, no wrangler needed
```
