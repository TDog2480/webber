# webber-backend

Owns the Cerebras API key and the call to the model provider. The Webber
extension is a thin client — it sends the user's command and the (compacted)
page schema here and applies whatever transform spec comes back.

## Run locally

```
npm install
cp .env.example .env
# put a real CEREBRAS_API_KEY in .env
# also set WEBBER_SHARED_SECRET in .env — the server refuses to start without it
npm start        # or: node server.js
```

Serves `POST /translate` on `PORT` (default `3000`).

## Request / response contract

`POST /translate`

Every request must send header `x-webber-secret: <WEBBER_SHARED_SECRET>`.

Request body:

```json
{ "command": "string", "schema": { "...": "any object, default {}" }, "mode": "string, default \"generic\"", "installId": "string" }
```

Response:

- `200 { ok: true, result: { transforms, mode, ruleName, confidence } }`
- `400 { ok: false, error }` — missing/invalid `command` or `installId`
- `401 { ok: false, error }` — missing or invalid `x-webber-secret` header
- `429 { ok: false, error }` — rate limit exceeded for this `installId`
- `500 { ok: false, error }` — server missing `CEREBRAS_API_KEY`
- `502 { ok: false, error }` — could not reach the model provider, provider
  returned a non-2xx status, or the model didn't produce a usable transform
  spec (no tool call / invalid JSON / malformed shape)

## Deploy

Any Node 18+ host works (Render, Railway, Fly.io, Vercel serverless, etc).
Set the env vars from `.env.example` in the host's dashboard — do not couple
this service to a platform SDK, it's kept as plain Express + `fetch` so it
runs anywhere Node 18+ runs.

The backend URL and shared secret are no longer edited in source. Instead,
after deploying, open the extension's side panel → **Settings** tab → set
**Backend URL** to `https://<your-host>/translate` and **Shared secret** to
match this deployment's `WEBBER_SHARED_SECRET`.

## Before you deploy

Set a real `CEREBRAS_API_KEY` **and** a `WEBBER_SHARED_SECRET` in `.env`, then
run `npm run smoke` once and confirm `SMOKE PASS` (a real transforms array
came back) before trusting the deploy.

## Notes

- The rate limiter is in-memory: it resets on server restart and doesn't span
  multiple instances. Redis (or another shared store) is a later upgrade, not
  needed for v1.
- `CEREBRAS_API_KEY` and the `Authorization` header are never logged.
- A shared secret is a private-v1 stopgap, not real access control — anyone
  who unpacks the extension can read it. Durable fix later: per-user auth.
