# Runbooks and troubleshooting

This page collects common local diagnostics for V-Amber. Add concrete incident
runbooks here as the project accumulates failures.

## Server does not start

Check `.env` for `YANDEX_SPEECHKIT_API_KEY`. SpeechKit API key is required at
startup.

Run:

```bash
npm start
```

If the process exits, inspect console output and `logs/server.log`.

## Browser cannot use microphone

Open the UI through the local server, not by opening `web-ui/index.html`
directly. The normal URL is:

```text
http://localhost:8080
```

When running Docker, the browser still runs on the host and connects to the
container through localhost port mapping.

## VK writes or MoySklad writes should be avoided

Use safe mode from the Web UI or `POST /api/safe-mode`. Safe mode blocks
external write actions while preserving recognition and logs.

## Need diagnostic evidence

Use the Web UI log download flow or the HTTP log bundle endpoints. The bundle
contains `manifest.json`, server logs, session logs, and wishlist diagnostic
data without secrets.

## `/api/*` returns 401 Unauthorized

`API_TOKEN` is set in `.env`. Open the UI once with
`http://host:PORT/?token=<API_TOKEN>` — the server stores an `HttpOnly`
cookie and redirects to the clean URL. Subsequent requests reuse the cookie.
See [[configuration-and-secrets]].

## WebSocket `/ws/stt` returns 403 Forbidden

The browser `Origin` is not on the allowlist. By default only loopback
(`localhost`, `127.0.0.1`, `[::1]`) is accepted. For real-domain
deployments, set `ALLOWED_ORIGINS` in `.env` to the CSV list of expected
origins. Look for `WARN ws origin_rejected` in `logs/server.log`.

## MoySklad / VK / SpeechKit status

`GET /health` returns `subsystems` with the last-known state of each
integration plus the safe-mode flag, and switches to `503` when MoySklad
has a `lastError` or when core credentials are missing. See
[[http-api#Core routes]].

## Related pages

- [[logging-and-diagnostics]]
- [[configuration-and-secrets]]
- [[operational-commands]]
