# Project review 2026-06-11

> **Status: partially remediated 2026-06-11, same day.** Fixed: #1 (CI test
> gate — `test` job added to `release.yml`, `release` depends on it), #2
> (`npm audit fix` → axios 1.17.0, audit clean), #3 (startup
> `WARN auth_disabled_on_lan` when `API_TOKEN` is unset on a non-loopback
> host), and the README test-count drift (180 → 290+, CI gate documented).
> Still open: #4 (query-string token), #5 (god-module split), #6 (variant
> lookup, web UI tests).

Full-repository review of V-Amber at version `0.1.54` (commit `9fce15c`,
branch `main`). Scope: architecture, code quality, security, tests, CI, and
documentation. Verified facts: `npm test` ran green locally (291/291 tests,
~38s) and `npm audit` was checked the same day.

## Verdict

The project is in good shape for a single-operator MVP. The test suite is
green, the riskiest flows (Бронь → MoySklad customer order, safe mode, crash
recovery) are guarded deliberately, and the wiki discipline is unusually
strong — known risks are written down instead of hidden. The main structural
debt is concentrated in four god modules, and the main process gap is that
releases ship without a CI test gate.

## Strengths

- **Tests: 291/291 passing.** Parsers (`article-extractor`,
  `reservation-parser`, `price-detector`, `discount-detector`,
  `quantity-command-parser`, `cancel-command-parser`) have focused unit
  suites, and the former integration-test gap is closed: seven
  `ws-server.*.test.js` files drive full WS sessions through a fake
  SpeechKit seam (`services.createSpeechKitSession`), covering reservations,
  cancellation, manual code entry, reconnect, and self-comment filtering.
- **Money paths are defended in depth.** `wrapWithSafeMode` is applied once
  in `server/index.js` on the shared MoySklad/VK clients, so HTTP and WS
  flows share one guard. Write calls deliberately avoid generic retry to
  prevent duplicate orders; GETs retry transient failures. Crash recovery
  (`recoverOrphansFromCrash`) surfaces orphaned брони to the operator
  instead of silently migrating them, and
  `reconcileConsumedFromSubmissions` repairs the submissions/wishlist gap
  after a crash between PO creation and consume.
- **Auth is small and correct.** `server/auth.js` uses
  `crypto.timingSafeEqual`, an Origin allowlist defaulting to loopback, and
  an HttpOnly SameSite=Lax cookie. The static server's `resolveAssetPath`
  guards against path traversal.
- **Observability culture.** JSONL session diagnostics with an explicit
  routed/unrouted split (`diagnosticRouter`), consecutive-failure
  escalation on product-cache refresh, log bundles, and Markdown session
  logs for the operator.
- **Config quality.** `server/config.js` documents every non-obvious
  default in place (confidence clamp rationale, bulk timeout sizing,
  trigger normalization) and validates min/max invariants at startup.
- **Knowledge base.** [[documentation-drift]] keeps contradictions
  explicit; raw log reviews carry status headers and get folded back into
  wiki pages when implemented.

## Findings

Ordered by importance.

### 1. Releases ship without a test gate (process, high)

`.github/workflows/release.yml` cuts a `vX.Y.Z` GitHub release on every
push to `main` without running `npm test`. The operator's Mac updates from
these releases, so a push with a broken suite still reaches production.
Recommended fix: add a `test` job (`npm ci && npm test` on the repo's Node
version) and make the `release` job depend on it. Cost is one job; benefit
is that the deploy path can't ship a red suite.

### 2. `npm audit`: 1 high severity (security, medium)

`axios@1.15.2` (transitive via `@yandex-cloud/nodejs-sdk@3.1.0`) is flagged
for GHSA-j5f8-grm9-p9fc (Proxy-Authorization leak on proxy re-evaluation).
Practical exposure is low — axios is only used inside the Yandex SDK and the
runtime doesn't route through proxies — but `npm audit fix` reports a clean
fix is available, so it's cheap to clear.

### 3. Unauthenticated-by-default on `0.0.0.0` (security, medium)

`API_TOKEN` is optional and `HOST` defaults to `0.0.0.0` (for Docker). With
no token set, any device on the LAN can hit the full API and the WS
endpoint; the Origin allowlist only protects against browser-initiated
cross-origin requests (non-browser clients send no Origin and pass). This
is an accepted MVP trade-off, but it deserves a startup `WARN` when
`auth.enabled === false` and the host is non-loopback, plus a one-line
hardening note in `README.md`/`SETUP_MACOS.md`.

### 4. Token accepted via `?token=` query (security, low)

`server/auth.js` accepts the API token in the query string. The HTTP path
mitigates this by 302-redirecting to a token-stripped URL, but the value
can still land in logs and browser history before the redirect, and the WS
upgrade path has no equivalent strip. Header/cookie paths already work;
consider deprecating the query form once the web UI no longer needs it for
the WS handshake.

### 5. God modules keep growing (maintainability, medium)

Current sizes: `server/ws-server.js` 3119 LOC (1919 after the 2026-05-29
extraction — it has regrown by ~1200 lines), `web-ui/app.js` 2963,
`server/moysklad.js` 1601, `server/http-server.js` 1154. The
`server/domain/` split has started (`voice-pipeline.js`), and the WS
integration scaffolding that previously blocked deeper splits now exists —
the precondition recorded in [[documentation-drift]] (2026-05-29 audit) is
satisfied. Reservation flow and VK comment polling are the natural next
extractions from `ws-server.js`. Module-level mutable counters needing
`__resetIdCountersForTests` are a symptom of the same coupling.

### 6. Known open risks remain open (tracked, for visibility)

Already recorded elsewhere, listed here so the review is complete:

- **MoySklad variants** ([[documentation-drift]], 2026-06-08): product
  lookup and the code cache query only `entity/product`; variant-only
  codes can be missed and duplicate numeric codes can resolve to the wrong
  Артикул. This is the highest-impact open correctness risk.
- **README drift**: `README.md` still says no verified test command exists.
- **Web UI untested**: `web-ui/app.js` (2963 LOC) has no tests at all;
  client-side aggregates (revenue, per-buyer totals) live there.

## Snapshot data

- Version `0.1.54`, 71 files indexed, ~12.3k LOC under `server/`,
  ~4.3k under `web-ui/`.
- Dependencies (4 runtime): `@grpc/grpc-js`, `@yandex-cloud/nodejs-sdk`,
  `dotenv`, `ws`.
- Test suite: 27 test files, 291 tests, all passing, ~38s wall time.
