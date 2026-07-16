# Project knowledge log

Append notable ingests, project questions, wiki maintenance passes, and durable
decisions here. Use a stable heading format so agents can scan recent changes.

## [2026-07-16] fix | CI deploy failed on first real run — rrsync anchors client paths

PR #8 merged; `Auto Release` succeeded, `Deploy stream viewer + chat service`
failed in 12s on its very first step. **Production was untouched** — the run
died on the stream-viewer rsync, before chat-service was copied or restarted,
so the box stayed on the previous code and kept serving (`/chat/health` and
`/efir/` both 200). No partial deploy.

Cause: `rrsync` chdirs into its restricted dir and **anchors** a client path
inside it — `if arg.startswith('/'): arg = args.dir + arg` (see
`/usr/bin/rrsync`, `validated_arg`). The workflow sent the real absolute
destination, so `/var/www/stream-viewer/` became
`/var/www/stream-viewer/var/www/stream-viewer` →
`mkdir failed: No such file or directory`. rrsync wants `.` or a path relative
to its root.

Sending `.` straight from the workflow doesn't work either: both targets would
then look identical in `SSH_ORIGINAL_COMMAND` and the dispatch `case` could not
tell them apart. Fix keeps the absolute path in the workflow (it documents where
the deploy goes) and has `ci-deploy-dispatch.sh` strip it and substitute `.`
before exec'ing rrsync — rrsync reads the command from `SSH_ORIGINAL_COMMAND`,
so rewriting the env var is enough. **The rrsync root stays narrow** (that one
directory, not `/var/www` or `/srv`) — widening it was the tempting shortcut and
is not acceptable with pay-service on the same host.

Lesson: the pre-merge check verified every *precondition* (user, paths, groups,
forced command, script hash byte-identical) and all of them passed — but nothing
ever exercised the deploy path itself, and the bug lived exactly there. Verified
installation ≠ verified execution. The dispatch rewrite is now covered by a
local stub test (both targets rewritten correctly; `restart-chat; cat
/etc/shadow`, arbitrary paths and arbitrary commands still rejected).

## [2026-07-16] fix | chat cursor lost every message past PUBLIC_PAGE_SIZE

Review of the own-эфир branch before merge found two bugs in the public
chat feed, both about the cursor/pagination contract. Reproduced by
running `deploy/chat-service` locally over a seeded `messages.jsonl` of
150 messages: the old client saw 100 of 150 and silently lost the 50
**newest**.

1. `GET /chat/messages` never served its "last 50" branch —
   `url.searchParams.get("after")` returns `null` when the param is
   absent, and **`Number(null) === 0`, not `NaN`**, so `Number.isFinite`
   was always true and a no-`after` request fell into the `after=0`
   branch, returning the *oldest* `PUBLIC_PAGE_SIZE`. `GET /chat/feed`
   never had this — it checks `afterParam === null` explicitly. Watch for
   this whenever a route distinguishes "absent" from "zero".
2. Clients advanced the cursor to `latestSeq`, which is the **global**
   max, while `messages` is capped at `PUBLIC_PAGE_SIZE` and filtered by
   the session floor — so anything beyond one page was skipped forever.

Fix: advance the cursor only over messages actually received, mirroring
`chatFeedCursor` in `server/ws-server.js` (~line 1787); use `latestSeq`
only to seat the cursor at start when there's nothing to show. **The
reservation feed was never affected** — it already used the per-message
pattern, so no order was ever lost; impact was display-only (`/efir/`
viewers and `#chatPanel`).

Verified against a live local chat-service: no-`after` now returns
msg-101..150, a cold cursor catches up all 150 without loss, the session
floor still hides the previous эфир and survives restart
(`sessionStartSeq` restored from `messages.jsonl`), 401 without token.
`npm test` 313/313.

## [2026-07-06] feat | chat viewer session reset via «Запустить эфир»

Operator saw stale test messages in `#chatPanel` because
`deploy/chat-service` has no session concept — one continuous
`messages.jsonl` forever, read as-is by both the dashboard and `/efir/`.
Considered a standalone "новая сессия" button first; user preferred
prompting at «Запустить эфир» time instead (own-server broadcast start),
since that's the real moment a new эфир begins for viewers, and it avoids
wiping an ongoing chat on an accidental OBS/network restart mid-broadcast
(operator can answer "продолжить"). Full design in
[[stream-integration#Chat session reset, tied to «Запустить эфир» (2026-07-06 — implemented)]].

Landed in checkpoints: `deploy/chat-service/server.js` (`kind:"session"`
marker, `POST /chat/session/new`, `sessionStartSeq` floor on
`GET /chat/messages`, restored from `messages.jsonl` on restart) →
`server/chat-client.js` (`postNewSession()`) → `server/http-server.js`
(`POST /api/chat/session` proxy) → `web-ui` (`#chatSessionBanner`,
`askChatSessionChoice()`, wired into `streamStartButton`, session-marker
divider rendering) → `deploy/stream-viewer/app.js` (same divider
rendering for viewers). `npm test` 313/313 throughout; no dedicated
automated test added (`http-server.js` has no existing test harness).

Manually verified end-to-end against a throwaway local chat-service
instance. **Incident during testing**: forgot this dev machine's OBS is
wired to the real production RTMP/MediaMTX — clicking «Запустить эфир»
during the test briefly (~1 min, 0 readers) started a real broadcast,
caught via server logs and stopped immediately. See the testing-gotcha
note in [[stream-integration#Chat session reset, tied to «Запустить эфир» (2026-07-06 — implemented)]]
for what to do differently next time.

## [2026-07-06] question | shooting from iPhone while V-Amber/OBS run on the Mac

Operator asked how to run V-Amber on the MacBook but shoot the эфир from an
iPhone. Answer: OBS orchestration is localhost-only
(`ws://127.0.0.1:4455`), so OBS must stay on the same Mac — the iPhone
becomes a camera/mic **source** inside OBS, not a second encoder. Recommended
Continuity Camera (macOS Ventura+/iOS 16+, Wi-Fi+Bluetooth or USB-C cable,
shows up as a normal OBS video-capture device, no plugin); fallback is a
virtual-webcam companion app (Camo/EpocCam/iVCam) for older devices. Explicitly
steered away from pushing RTMP straight from the phone (e.g. Larix) to
MediaMTX, since that would bypass OBS and break the one-button
`startBroadcast`/`stopBroadcast` control. No V-Amber code change — pure OBS
scene configuration. Full guidance in
[[stream-integration#Shooting from a phone while OBS/V-Amber run on the Mac (2026-07-06, question)]].

## [2026-07-06] feat | эфир mode toggle (ВК vs свой сервер) in the dashboard

`#efirModeToggle` in the topbar (`web-ui/index.html`, next to
`#sessionPill`) lets the operator pick which broadcast method they're
running so only its controls show: "ВК эфир" reveals `#vkLiveUrlWrap` and
hides `#streamPanel`/`#chatPanel`; "Свой эфир" does the opposite (both still
gated on `state.streamConfigured`/`state.chatConfigured` from their existing
config fetches). Choice persists in `localStorage["efirMode"]`
(`applyEfirMode()` in `web-ui/app.js`), default `"vk"`.

**Deliberately UI-only.** VK-comment polling and the viewer-chat poll
(`/api/chat/messages`) keep running in parallel no matter what the UI shows —
the toggle is never sent to the server. User's call: a future multi-platform
setup may run VK and the self-hosted stream at once, and tying reservation
intake to the currently-visible tab risks silently dropping orders from the
hidden channel. See [[stream-integration#Эфир mode toggle (2026-07-06)]] and
[[web-dashboard]].

Verified manually via the preview browser tool (mode switch shows/hides the
right panels, survives a reload, chat/VK network polling continues in both
modes) and `npm test` (313/313, unaffected — server-side untouched).

## [2026-07-05] feat | viewer page + own chat as second reservation source

Toward broadcasts fully off VK. Decision (user, after weighing Telegram vs
own chat vs VK hybrid): **own chat on the viewer page**. Everything is
additive — VK comments keep working; both sources feed one lot / one stock
gate / one MoySklad order. See [[stream-integration]] for design details.

- `deploy/stream-viewer/` — public watch page `/efir/` (vendored hls.js 1.6
  — jsdelivr is unreliable in RU; offline auto-retry; muted-autoplay unmute
  button) + chat column (join with name+phone, 3s polling). nginx locations:
  `/efir/` static, `/live/` HLS proxy, `/chat/` chat service — all
  same-origin on the 443 vhost.
- `deploy/chat-service/` — zero-dep node:http chat on `cloud` (docker,
  loopback:8890). Phone required at join (a бронь needs a contact), shown
  only to the operator feed under `X-Chat-Token`. Viewer/comment ids in the
  9e9+ range so VK id paths work unchanged.
- **VK ID login added same day** (user: chat identity must not break the
  VK-id → MoySklad counterparty mapping): primary «Войти через VK» button on
  the join panel, OAuth 2.1 PKCE flow in chat-service (no app secret), real
  VK user id + name + verified phone from `id.vk.com`; phone join stays as
  fallback (synthetic 9e9+ id → new counterparty, accepted trade-off).
  Requires a VK ID web app: `VK_APP_ID` + `PUBLIC_BASE_URL` in the service
  env, redirect `/chat/auth/vk/callback` — setup steps in the README.
- V-Amber: `server/chat-client.js`; in `ws-server.js` the per-comment logic
  moved verbatim into `ingestViewerComment({...,source})` shared by the VK
  poller and the new chat poller (separate generation — VK poison must not
  kill chat intake); `notifyReservationStatus` routes the reply by
  `event.source`. Log events keep their names with component `chat` +
  `source`/`viewerPhone` meta, so order-recovery-from-logs keeps working.
- Tests: `test/ws-server.chat-source.test.js` (+`createChatClientMock`);
  chat-service smoke-tested end-to-end locally. 313/313 green.
- **Deployed to `cloud` 2026-07-05** (user approved ssh): page files in
  `/var/www/stream-viewer/`, chat service via docker compose in
  `~/chat-service/` (`.env`: OPERATOR_TOKEN + `VK_APP_ID=54665906` +
  PUBLIC_BASE_URL), three nginx locations inserted after `/mediamtx/`
  (backup `*.bak.<epoch>`, `nginx -t`, reload). Verified externally:
  `/efir/` 200 + own CSP, `/chat/health|config` OK, feed 401 without
  token, VK start 302, full join→message→feed→service-reply cycle through
  the public domain; test data wiped afterwards. **CSP gotcha**: the vhost
  ships `script-src 'self'` and no `media-src`, so the page keeps all JS
  in `app.js` (no inline scripts) and `location /efir/` re-declares CSP
  with `media-src blob:` (hls.js MSE) — any `add_header` in a location
  replaces ALL inherited vhost headers. The VK callback therefore hands
  the chat token via `302 /efir/#chatAuth=<base64url>` instead of an
  inline-script bridge page. MediaMTX HLS answers `/live/index.m3u8` with
  a `302 ?cookieCheck=1` first — normal, hls.js follows it. VK ID app
  54665906 created by the user; the `phone` scope is pending VK
  moderation — until approved the VK login works but returns no phone.
  Operator still needs `STREAM_CHAT_URL`/`STREAM_CHAT_TOKEN`/
  `STREAM_VIEWER_URL` in the Mac `.env` (values mirror the repo-dev
  `.env`), plus the branch merged to `main` and released.

## [2026-07-03] feat | one-button broadcast: nginx proxy + OBS orchestration

Two changes that together turn the stream panel from "connection info +
status indicator" into a one-button start/stop for the operator. See
[[stream-integration]] for the full design.

**MediaMTX API proxy (infra)**: the SSH-tunnel requirement is gone. Added
`location /mediamtx/` to `cloud`'s host nginx 443 vhost
(`amberapp_domain.conf`, backed up per local `*.bak.<epoch>` convention)
→ `127.0.0.1:9997`, gated by an `X-Stream-Token` header check (401
otherwise; verified externally both ways). Token lives in the nginx conf
and `.env` (`STREAM_MEDIAMTX_API_TOKEN`) only. `getStreamStatus()` sends
the header when the token is set. Gotcha: `sites-enabled/*.bak.*` files
are parsed by nginx and cause pre-existing "conflicting server name"
warnings on `nginx -t` — harmless.

**Orchestration**: `server/obs-client.js` (obs-websocket v5 over existing
`ws` dep, short-lived connection per op, `ObsError` codes) +
`server/stream-orchestrator.js` (`preflightBroadcast`/`startBroadcast`/
`stopBroadcast`, never throws, `{ok, steps[]}` with per-step
ok/fixed/fail + operator hints, auto-launches OBS and writes RTMP
server/key). Routes `/api/stream/preflight|start|stop`. UI: «Запустить
эфир»/«Остановить»/«Проверить эфир» buttons + `#streamChecklist` step
list; the page-load 5s status poll is replaced by an on-demand loop that
auto-stops after 3 offline cycles (kills the `status_poll_failed` WARN
spam when MediaMTX is deliberately off). Stream failures stay isolated
from the voice/lot/reservation flow: every stream path degrades to a
structured response, nothing propagates.

## [2026-07-02] fix | stream-panel layout bug + manual end-to-end verification

Follow-up to the OBS-auth-gap fix and firewall work logged below same day
— this entry covers the dashboard layout bug found while manually
verifying the panel, plus the verification outcome itself.

**Layout bug**: `.stream-field` (label + input + "Копировать" button)
clipped the button in the 380px right column regardless of window size —
two separate flexbox min-width gotchas (grid column not shrinking below
child min-content; text `<input>`'s browser-default intrinsic min-width
ignoring its `flex:1`). Rather than chase exact pixel budgets, restructured
to stack label above input+button (`flex-wrap: wrap` + `flex-basis: 100%`
on the label) so the row always has the full column width to work with.

**Manually verified end-to-end on this dev machine** (local `.env` with
real `STREAM_*`/`API_TOKEN` values, SSH tunnel to `cloud`'s loopback-only
MediaMTX API): dashboard panel renders correctly, `/api/stream/config` and
`/api/stream/status` return expected shapes, `obsStreamKey` matches the
publish URL form already confirmed to work via ffmpeg. Clarified for the
operator that there's no in-dashboard "start stream" button — video
publish happens from OBS (or any RTMP encoder) pushing to MediaMTX
directly; the panel only displays connection info and polls status.
Browser-based (WebRTC/WHIP) publish was discussed and deliberately
deferred — would need enabling WebRTC ingest on `cloud` (currently off)
plus getUserMedia/WHIP client work; out of scope for this MVP.

## [2026-07-02] fix | stream panel follow-up: firewall open, 5 review findings closed

**Firewall.** Operator opened the cloud.ru security-group rules for
`1935:1935/tcp` and `8888:8888/tcp` on `0.0.0.0/0` (console: `Группы
безопасности` → `SSH-access_ru.AZ-2`). Confirmed externally reachable with
a raw TCP connect from outside `cloud` on both ports, and independently by
MediaMTX's own logs already showing unsolicited internet-scanner RTMP
connections the same day. RTMP publish auth verified too: a throwaway
`mwader/static-ffmpeg` container published successfully using
`rtmp://<host>:1935/live?user=publisher&pass=<publishPass>` — the
`user:pass@host` URL form fails DNS resolution in ffmpeg's native RTMP
muxer, so the query-string form is the one to document/use. Infra blocker
from [[stream-integration]] is now closed.

**Code — closed the 5 lower-severity findings left open from the PR #8
review (fdb20fb / 18c7560):**
- `server/config.js` — `config.stream.apiUrl` now strips a trailing slash
  so `STREAM_MEDIAMTX_API_URL` with a trailing `/` can't produce a
  double-slash request path in `stream-status.js`.
- `web-ui/app.js` `pollStreamStatus()` — error label now includes the
  actual error text (`Ошибка связи с сервером: <detail>`) instead of a
  generic string, so an operator mid-incident can see *why* the stream
  indicator is red, not just that it is.
- `web-ui/app.js` — added `state.streamStatusPolling` in-flight guard so
  a slow `/api/stream/status` request can't overlap with the next 5s
  `setInterval` tick.
- `server/http-server.js` `/api/stream/status` — the catch-all error path
  (only reachable if `getStreamStatus()` itself throws, which it
  shouldn't since it catches internally) now returns the same `200` shape
  as the normal payload instead of a differently-shaped `500`, so callers
  never need to branch on status code.
- Wiki — the real prod IP (`176.108.255.4`) is no longer pasted in
  [[stream-integration]] or this log; references now point to the `cloud`
  SSH alias.

**Found + fixed a real OBS-auth gap while planning manual verification.**
`mediamtx.yml`'s `authInternalUsers` requires `user` **and** `pass`
together to publish, but the dashboard only ever surfaced `publishPass` as
the OBS "Stream Key" — `publishUser` was never sent to the operator
anywhere, so a real OBS session would have hit the same
`authentication failed` I got when testing with no credentials at all.
Fixed: `GET /api/stream/config` now returns `obsStreamKey` =
`${pathName}?user=${publishUser}&pass=${publishPass}`, and the dashboard
shows that instead of the raw password. Convention changed:
`STREAM_RTMP_URL` must now be the **bare** server (`rtmp://<host>:1935`,
no `/live`) so OBS's Server+"/"+Key concatenation lands on the right
path — `.env.example` and [[configuration-and-secrets]] updated.
**Action needed on the Mac deployment**: `STREAM_RTMP_URL` in the
operator's `.env` still has the old `/live`-suffixed form and must be
trimmed to the bare server after this code ships (see
[[deploy-topology]] — code changes there only take effect via
push→release→manual update).

`npm test`: 311/311.

## [2026-06-29] feature | day-agnostic merge заказов через дни кампании

**Запрос оператора.** Эфиры идут несколько дней подряд = одна кампания; у клиента
должен быть **один** заказ на всю кампанию: в первый день заказ создаётся, в
следующие дни новый клиент → новый заказ, вернувшийся клиент → дописывается в свой
существующий открытый заказ. Граница кампании (подтверждено): **пока заказ открыт**
— оператор закрывает (Запакован/Оплачен/…) → следующая бронь начинает новый.

**Было.** Мердж был привязан к **локальной дате** (`findLatestBroadcastCustomerOrder`
требовал маркер `#Эфир <сегодня>`, `broadcastDate` из локальной даты комментария) →
заказы за разные дни не сливались (см. запись о ручном merge 27+28 выше).

**Стало.** `config.moysklad.crossDayOrderMerge` (env `MOYSKLAD_CROSS_DAY_ORDER_MERGE`,
default **on**, `=0` — откат к старому). В campaign-режиме поиск переиспользует
последний **открытый** заказ клиента с **любым** маркером `#Эфир ` (не только
сегодняшним), на том же `appendBlockedStateHrefs` — оплаченные/закрытые отсечены.
Матч по `#Эфир ` (а не по «любой открытый») не даёт угнать посторонний ручной заказ.
Append уже штампует маркер дня (`ensureOrderHasBroadcastDescription`) → один заказ
копит `#Эфир 27/28/29…` для истории/AuctionBot. Call-site в `ws-server.js` не менялся
— флипается конфигом; кэш `viewerId+date` оставлен (безвреден, lookup — источник
истины между днями).

**Окно кампании.** Чтобы заказ недельной давности НЕ сливался: `campaignMaxGapDays`
(env `MOYSKLAD_CAMPAIGN_MAX_GAP_DAYS`, default **3**). Сливаем только если самый
свежий маркер `#Эфир <дата>` в заказе ≤ 3 дней от текущей брони (граница включительно);
старше → новая кампания → новый заказ. Маркер штампуется на каждый append, окно
скользит с активностью (эфиры подряд с пропуском 1-2 дней — один заказ; 7 дней — нет).

**Файлы.** `server/config.js` (2 флага), `server/moysklad.js`
(`findLatestBroadcastCustomerOrder` — матч по любому `#Эфир ` + окно давности),
комментарий в `server/ws-server.js`; тесты `test/moysklad-open-order-check.test.js`
(+5: cross-day reuse, окно 7д не сливается, граница 3д сливается, флаг-откат, не-эфир
заказ не трогаем; legacy-пагинация переведена на флаг off). **296/296 зелёные.** Вики:
[[reservation-flow]] «Customer-order merging across campaign days». Деплой — только
через push→release→обновление на Mac ([[deploy-topology]]).

## [2026-06-29] merge | заказы эфиров 2026-06-27 + 2026-06-28 слиты по покупателям

**Зачем.** Мердж заказов **привязан к дате**: живой флоу (`ws-server.js:1140`
→ `findBroadcastCustomerOrderForCounterparty` → `moysklad.js:724`
`findLatestBroadcastCustomerOrder`) переиспользует заказ покупателя только с
маркером **текущей** даты `#Эфир <дата>` (строка 1132: «but only for the current
#Эфир marker»), а `broadcastDate` берётся из **локальной** даты комментария
(`ws-server.js:954` → `formatBroadcastDate`). Поэтому покупатель, бравший в эфир
27-го (заказы восстановлены постфактум) и 28-го (живой эфир), получил **два**
заказа. Day-agnostic `findLatestOpenCustomerOrder` в коде есть, но живой флоу его
**не вызывает** → авто-слияния между эфирами/через полночь нет (это не баг
рантайма, а граница дизайна — менять lifecycle по [[reservation-flow]]).

**Сделано.** `scripts/merge-broadcast-orders.mjs --into 2026-06-27 --from
2026-06-28 --execute`: 19 покупателей с заказами в обоих эфирах слиты — survivor
= заказ 27-го (как сделал бы day-agnostic lookup), 52 позиции перенесены с
сохранением цены/скидки/резерва, в описание добавлен второй маркер `#Эфир
2026-06-28`, 19 заказов-28 удалены (в Корзину, обратимо). Проверка: пересечений
0/19, survivor'ы несут оба маркера, маркер-теги 27×27 / 28×36 сходятся.

**Открыто:** хотим ли day-agnostic merge в рантайме (чтобы будущие эфиры через
полночь / возвраты покупателей не расщеплялись) — решение за оператором; затрагивает
чтение AuctionBot по маркеру `#Эфир`. Артефакт: [[service-scripts]] →
`merge-broadcast-orders`.

## [2026-06-29] review+checklist | эфир 2026-06-28 — здоровый прогон, исправлены 4 нулевые цены

**Проверка эфира 2026-06-28** (4 сессии, версия `0.1.57`, Mac). Эталонный
прогон, контраст к инциденту 06-27: `moysklad_call` — **617 вызовов, 0 ошибок**
(518 GET / 96 POST / 3 DELETE), токен живой, заказы писались вживую. Итог: 95
комментариев = 95 распознанных броней; **89 живых позиций** в 36 заказах (36 новых
+ 53 дозаписи), 3 отмены чисто удалены (3 DELETE). Структура чистая: 0 «сборных»
заказов, 0 дублей позиций, 0 `product_not_found`. Вейтлист 16 pending → **16
promoted** (100%). Все 6 `out_of_stock` попали в вишлист (`added`=6).

**Найден дефект цен.** 5 живых позиций ушли в МойСклад с ценой 0, хотя оператор
**называл цены голосом** — слабое место голосового парсинга (см.
[[voice-price-parsing]]): цена/скидка произнесена *до* `lot_opened` (03059, 03082)
или *после* финализации брони — при этом `lot_price_changed` (напр. 03081 → 3828,
посчитан системой) **не подтягивается в уже созданную позицию заказа** — либо
скидка % без базовой цены (`discount_skipped: no_amount_extracted`, 03172).

**Исправление.** `scripts/fix-zero-price-positions.mjs` — PUT цены в позиции:
03081→3828, 03059→1487.50, 03082→1470 (×2). `03172` оставлен (базовая цена не
озвучена и в каталоге пусто) — нужен оператор.

**Артефакты.** Новая страница [[log-verification-checklist]] (полный чек-лист
проверки эфира по логам) + read-only `scripts/analyze-broadcast-logs.mjs`
(считает все метрики чек-листа) + `scripts/fix-zero-price-positions.mjs`. Линки в
[[index]] и [[service-scripts]].

## [2026-06-28] incident+recovery | эфир 2026-06-27 — MoySklad 401, заказы восстановлены из логов

**Инцидент.** Оба эфира 2026-06-27 (сессии 19:16 и 21:25, версия `0.1.57`) прошли
с протухшим токеном МойСклад — каждый `moysklad_call` возвращал HTTP 401,
`productCache` пустой. Итог: 93 брони распознаны и залогированы, но **0 заказов**
создано (`reservation_finalized` со `status: product_not_found`). Брони выжили
только в `sessions/*.jsonl` диагностического бандла.

**Восстановление (по рабочим кредам в `.env`).** Реплей броней в МойСклад тем же
клиентом, что и боевой флоу: артикул→товар (`getProductCardByCode`,
+ добивка ведущего нуля), покупатель→контрагент (`ensureCounterparty` по
атрибуту VK ID). Политика остатка (решение оператора): первым пришёл — первым
получил, до текущего `availableStock`, остальное в overflow.

- **27 заказов покупателям / 76 позиций** под маркером `#Эфир 2026-06-27`
  (AuctionBot читает их после эфира — см. границу в записи 2026-06-23).
  Сверено по факту: 76 уникальных пар (контрагент, товар), 0 дублей, сумма
  135 130 ₽. Создано 4 новых контрагента `VK: <имя>`.
- **1 заказ поставщику** (`00001`) на 17 не поместившихся единиц (11 товаров) →
  **ИП Галямов Дмитрий Сергеевич**. В описание заказа вынесена разбивка
  «артикул × кол-во: покупатели», чтобы видеть, кому предназначено (у строк PO
  нет текстового поля).

**Цена/скидки.** Заказы покупателям — по `salePrice` карточки; скидки, звучавшие
в эфире, потеряны (в бронях `salePrice: 0`). PO — по `buyPrice`, у этих товаров
он `0` (проставить вручную).

**Артефакты.** Скрипты `scripts/recover-orders-from-logs.mjs` и
`scripts/recover-overflow-purchase-order.mjs` (идемпотентны, `--execute`/`--update`).
Полная процедура и грабли — [[order-recovery-from-logs]]; ссылки на скрипты —
[[service-scripts]]. Первопричина (протухший токен) — чинить отдельно, чтобы не
повторилось.

## [2026-06-23] intake | operator wishes — discounts (open) + AuctionBot boundary

Из VK-переписки с оператором (Роман) 2026-06-23. Бóльшая часть пожеланий
(покупательский кабинет в ЛС VK: просмотр брони, самостоятельное удаление
позиций, ссылка на оплату, купоны, бесплатная доставка, штраф «срезаем скидку»
за удаление из неоплаченного заказа) **относится к AuctionBot**, а не к V-Amber —
зафиксировано в их базе (`Amberry39/.../operator-wishes-2026-06-23-buyer-vk-cabinet.md`).

- **Граница (подтверждено, «вариант А»):** оба проекта на одном МойСкладе;
  V-Amber пишет заказы с маркером `#Эфир <дата>`, AuctionBot сам читает их после
  эфира. Явной передачи между проектами нет — отдельной задачи на «выгрузку»
  у V-Amber не возникает.
- **Зона V-Amber — только правила скидок, статус ОТКРЫТО.** Оператор хочет уйти
  от ручной диктовки скидки голосом к скидке по правилам (дефолт эфира и/или
  адресные правила на товар). Решено **отложить** до проработки дизайна
  («скидочную систему нужно продумать»). **Решено 2026-06-23: приоритет —
  голос на эфире всегда выше любого правила; правила только заполняют там, где
  скидку не озвучили.** Детали и открытые вопросы — в
  [[operator-feedback#Operator wishes 2026-06-23 (Roman — discounts +
  cross-project boundary)]].

## [2026-05-24] maintenance | Move V-Amber vault to Amberry39-style structure

Reworked the initial V-Amber Obsidian notes into the same structure used by
`D:\myprojects\AuctionBot Amberry\Amberry39`:

- `knowledge/raw/` for source snapshots and redacted evidence;
- `knowledge/wiki/` for maintained project knowledge;
- `knowledge/wiki/index.md` as the agent entry point;
- `knowledge/wiki/log.md` as the maintenance record;
- `templates/` for decision, incident, runbook, and source-ingest notes.

Added wiki pages for project overview, repo map, runtime architecture,
configuration, commands, tests, live-commerce flow, reservation flow, wishlist,
operator feedback, preorders, integrations, diagnostics, troubleshooting,
documentation drift, and the Amberry39-style plugin workflow guide.
Migrated the earlier `Sources/` and `Wiki/` operator-test notes into
`knowledge/raw/log-review-2026-05-24-18-45.md` plus canonical pages for voice
price parsing, stock synchronization, and VK comments.

Source note:
[[../raw/project-wiki-ingest-2026-05-24|project-wiki-ingest-2026-05-24]].

## [2026-05-24] ingest | Initial Obsidian wiki population

Created the first V-Amber wiki pass from `AGENTS.md`, `README.md`, `TODO.md`,
`package.json`, repository file lists, CodeGraph context, and the existing
operator feedback note.

## [2026-05-25] maintenance | Trim agent files into operating guides

Moved durable reference material out of `AGENTS.md` and `CLAUDE.md` into the
Obsidian wiki. Added [[http-api]], [[release-process]], and
[[macos-launchers]]. `AGENTS.md` now keeps source-of-truth order, verified
commands, key guardrails, and the Obsidian workflow. `CLAUDE.md` now contains
Claude-specific pointers only.

## [2026-05-25] cleanup | Remove legacy Obsidian draft folders

Deleted the old root-level `Sources/` and `Wiki/` Markdown notes after their
content was migrated into the Amberry39-style structure:

- source evidence now lives in
  [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]];
- maintained pages now live under `knowledge/wiki/`, including
  [[operator-feedback]], [[reservation-flow]], [[wishlist]],
  [[voice-price-parsing]], [[stock-synchronization]], and [[vk-comments]].

## [2026-05-25] maintenance | Code pass over runtime APIs and stores

Re-scanned CodeGraph, `server/http-server.js`, `server/index.js`, runtime
stores, service scripts, and `web-ui/app.js`. Updated wiki with current HTTP
surface, dashboard workflows, runtime persistence stores, reservation digests,
and service scripts. Added [[runtime-stores]], [[web-dashboard]],
[[service-scripts]], and [[reservation-digests]].

## [2026-05-25] decision | Scope live order merging to broadcast day

Recorded the rule that live MoySklad customer-order merging is limited to one
calendar broadcast day per buyer. The first reservation for a buyer creates an
order with a daily `#Эфир YYYY-MM-DD` marker; later reservations from the same
day may append only to an order with that marker. Older open or unpaid orders
without the marker stay separate.

## [2026-05-29] maintenance | Operator audit pass

Recorded the operator-audit pass that landed UI and backend improvements:
inline product-code cache banner, non-blocking wishlist delete confirm,
visible VK live URL field, connection-drop restart banner, persisted microphone
selection, keyboard shortcuts, low-stock and lot-age indicators, digest quick
buttons and post-stop summary, API-token `/login`, single-WS guard, manual lot
close, manual price override, and per-buyer running totals.

The durable details live in [[operator-feedback]], [[web-dashboard]],
[[http-api]], [[runbooks-and-troubleshooting]], and [[testing-guide]].
Deferred backend-risk items were split into [[deferred-operator-features]]:
#14 manual code entry and #16 cancel reservation.

## [2026-05-30] feature | Manual article code entry (#14)

Landed operator manual code entry for active streams. The dashboard shows the
`код вручную` field while streaming; it sends the `manualCode` WS message, and
the server rejects codes not found in the MoySklad catalog. Integration tests
cover the active-lot scenarios, including floor=1 reservation behaviour and
same-code merge stability.

Updated [[deferred-operator-features]], [[http-api]], [[web-dashboard]], and
[[runbooks-and-troubleshooting]] for #14.

## [2026-05-30] feature | Cancel reservation from the dashboard (#16)

Landed the last deferred operator-audit item. WS `cancelReservation`,
MoySklad `removePositionFromOrder` (exact-id `DELETE`, safe-mode wrapped,
404 = idempotent), per-row `× отменить` button, and
`test/ws-server.cancel-reservation.test.js`. Updated
[[deferred-operator-features]] (moved #16 to landed with the failure-mode
design record), [[reservation-flow]] ("Cancelling a reservation"),
[[http-api]], [[web-dashboard]], [[runbooks-and-troubleshooting]], and the
wiki [[index]]. No deferred operator-audit items remain.

## [2026-05-30] feature | Start Phase 3 multi-lot runtime

Changed the runtime from a single active lot to a current `activeLot` plus an
`openLotsBySessionId` registry. Opening a different code keeps previous lots
open, one VK comment poller routes reservations by product code across open
lots, `stale_detection` no longer auto-closes late detections, and
`stream_stop`/`stream_end`/errors/socket close bulk-close all open lots.
`logs/active-state.json` now persists `openLots` for crash-recovery orphan
scans. Updated [[reservation-flow]] and `PLAN.md`; full `npm test` passes.

Follow-up UI pass: `web-ui` now renders `#openLotsList`, marks the current
active lot, lets the operator close a specific open lot by `lotSessionId`/code,
and renders reservations from all open lots with lot-aware cancel actions.
Updated [[web-dashboard]]. Full `npm test` passes.

Final Phase 3 guard: added an integration test for overflow on an inactive
open lot. With current `activeLot` on a different code, a previous open lot
with stock 1 accepts the first buyer and sends the second buyer to
`out_of_stock`/wishlist. Full `npm test` passes with 185 tests.

## [2026-05-30] feature | Waiting-list manual mode (W5/W6)

Landed the first phase of Roman's 2026-05-30 waiting-list requests. When stock
is exhausted, valid reservation overflow continues to create a wishlist entry
through `addWishlistFromComment(..., "out_of_stock_reservation")`, but
`out_of_stock` no longer publishes a public VK reply. This keeps the list
available to the operator while avoiding noisy buyer-facing comments during
manual mode.

The wishlist UI renamed the old `Зрители` column to `Заказавший` and now shows
the buyer name (`viewerName`, with `+N` for repeated seen-events). Updated
[[operator-feedback]], [[wishlist]], [[web-dashboard]], and [[vk-comments]].

## [2026-05-30] maintenance | Harden macOS updater

Investigated an operator macOS update failure from `0.1.26` to `0.1.33`.
The old updater downloaded the GitHub release but failed during `unzip` on the
Cyrillic file `Добро пожаловать.md`, showing a misleading `disk full?` message
and a mangled `????.md` filename.

Updated `update.command` to prefer macOS `ditto` for ZIP extraction, then
fallback to `bsdtar` and `unzip`, and to preserve `.git` during rsync-based
replacement. Recorded the one-time launcher permission repair:

```bash
chmod +x *.command
xattr -d com.apple.quarantine *.command 2>/dev/null || true
```

The operator reran the updater successfully and reached version `0.1.33`.
Updated [[macos-launchers]] and [[release-process]].

## [2026-05-31] analysis | Review 2026-05-30 diagnostic bundle

Reviewed `logs/v-amber-logs-2026-05-30T21-02-01-424Z.zip`: five sessions,
79 lots, 42 accepted reservations, 325 MoySklad calls, and one fresh `0.1.33`
session with 17 lots / 11 reservations / 0 MoySklad errors.

Recorded the main problems and operator wishes in
[[../raw/log-review-2026-05-30-21-02|log-review-2026-05-30-21-02]] and
summarized them in [[operator-feedback]]. The highest-signal items are VK
publish failures at stream close, `photo is undefined` on a lot card,
safe-mode visibility, stock-unknown reservations, variant-code confusion,
manual code entry as a primary workflow, faster cancellation search/voice
assist, official group identity for buyer replies, quiet DM/hidden service
notifications, quantity phrases, and continued price/discount parser work.

## [2026-05-31] ux | Type supplier names in wishlist

Changed the active wishlist `Без поставщика` row control from a native supplier
dropdown to a text input with browser suggestions from cached MoySklad
suppliers. Operators can type part of the supplier name, select the matching
suggestion, and the UI still patches the entry with the resolved `supplierId`
and `supplierName`.

Updated [[web-dashboard]] and [[wishlist]].

## [2026-05-31] maintenance | Close operator-wishes ctx session

Closed the active session plan for Roman's 2026-05-30 operator wishes. The
implementation phases are recorded as complete in the handoff, with manual
browser smoke testing for two open lots and a fresh full `npm test` left as
explicit follow-ups before release or commit.

## [2026-05-31] reliability | Fix VK close/photo and safe-mode visibility

Addressed the highest-priority runtime issues from the 2026-05-30 diagnostic
bundle review. VK lot-card publishing now uploads only complete photo objects
and omits empty attachments from `video.createComment`, preventing the
`photo is undefined` failure for products without usable images.

Stream-end lot closing now treats fatal/video-unavailable VK errors, such as
`VK API 15: video not found`, as an ended-video condition: it logs one warning
and skips close-comment publishing for the remaining open lots instead of
emitting repeated publish failures. The operator dashboard also shows a
pre-stream safe-mode banner when external writes and VK publishing are blocked.

Added `test/vk.test.js` and a WebSocket harness case for stream-stop close
publishing. Full `npm test` passes with 190 tests.

## [2026-05-31] policy | Unknown-stock and unknown-code gates

Chose the policy for stock that MoySklad refuses to number when a lot is
opened: **first slot + explicit warning**. The flow stays at floor=1 (one
buyer is accepted, matching operator intent of "I'm holding it in hand")
but the lot now carries `product.stockUnknown=true`, the operator gets
a `warning` toast about resale risk, and the UI renders an amber pill
"остаток неизвестен · риск перепродажи". Subsequent reservations on the
same lot hit `committedReservationCount > 0` and bounce to wishlist as
usual. See [[reservation-flow]].

Plugged a second silent-failure path on the voice/LLM gate. Manual entry
already rejected codes that the MoySklad catalog cache did not contain,
but the voice-confirmed path opened a lot with a null product card. The
gate now runs in `handleConfirmedDetection` for any source: if the
catalog is loaded and the chosen code is not in it, the lot is not
opened, the operator sees "Код N не найден в каталоге МойСклад", and the
event is logged as `voice_code_rejected_unknown`.

## [2026-05-31] maintenance | Consolidate Obsidian rules into one canonical page

The rules for working with the vault were split across three places —
`AGENTS.md` (Obsidian workflow section), [[project-conventions]] (Obsidian
conventions section), and [[obsidian-knowledge-base]] — and partially
duplicated. The pages also did not document things that agents actually
need to do their job:

- The exact log-entry heading shape (`## [YYYY-MM-DD] <type> | <title>`) and
  the catalog of `<type>` values.
- When to create a new page vs append to an existing one.
- When to touch `index.md`.
- Wikilink hygiene (raw-note link form, broken-link tolerance, no manual
  backlinks).
- Raw-note contract.
- Page-staleness and deletion protocol.
- The `documentation-drift.md` decision tree.

Moved all of that into [[obsidian-knowledge-base]] as the single source of
truth. `AGENTS.md` and [[project-conventions]] now keep only a short
pointer plus the no-secrets rule. No content was lost.

## [2026-05-31] parser | Stage 6 — tolerant codes and stronger price/discount

Buyer-comment routing now zero-pads short buyer codes against the open
lot. «бронь 0588» reaches a lot opened under code «00588» as long as no
other open lot is an exact match for «0588». Padding only adds leading
zeros, so codes that lose a non-zero leading digit (e.g. «10588» →
«0588») will not produce a false positive.

Price detector accepts «тысячу» (accusative singular), the common
operator pronunciation. Discount detector splits glued «30%» tokens
into «30» and «%», so «скидка 30%» and «20% скидки» now resolve to
percent discounts. New `test/discount-detector.test.js` covers the
percent-order, percent-glued, and absolute paths.

Live quantity phrases («забронируй сразу две штуки») stay deferred:
they would create reservations off speech alone, which contradicts the
voice-confirms-not-acts rule from stage 1. Needs operator decision on
which live action they should trigger.

## [2026-05-31] identity | VK service replies go through community token

Stage 5: routed all live-video `video.createComment` writes and the
matching `photos.getWallUploadServer` / `photos.saveWallPhoto` uploads
through a derived `commentToken = VK_GROUP_TOKEN || VK_ACCESS_TOKEN
|| VK_USER_TOKEN`. Operator confirmed `VK_ACCESS_TOKEN` is a community
access token, so the fallback chain lets the existing .env produce
group-identity comments without renaming the variable. Reservation
reply text now embeds the lot code, e.g. «Аня, бронь подтверждена (код
03204).», so buyers can tell which article the service reply confirms
when multiple lots are open. See [[vk-comments]].

Variant/modification ambiguity still open. `moysklad.getProductCardByCode`
queries only `entity/product?filter=code=...`. A code that lives on a
variant (modification) currently returns null and trips the unknown-code
gate above. Fixing it cleanly requires (1) a fallback to
`entity/variant?filter=code=...&expand=product`, (2) a separate stock
query against the variant's assortment href, and (3) a snapshot builder
that joins the variant's characteristic name onto the parent product
name. Left for a focused follow-up with real MoySklad fixtures.

## [2026-06-01] analysis | Analytics tracking plan

Applied the analytics-tracking workflow to the current operator dashboard.
No active analytics SDK, GTM container, `gtag`, `dataLayer`, PostHog,
Mixpanel, Amplitude, or Segment implementation was found in source files.

Added [[analytics-tracking-plan]] as the measurement contract for future
implementation. The plan prioritizes internal operator workflow events,
reservation conversions, wishlist purchase-order completion, digest sends,
safe-mode state, and redacted reliability analytics over public marketing
attribution.

Follow-up review added a required non-PII common event envelope so future
JSONL analytics can be deduplicated and joined to local diagnostic bundles.

## [2026-06-01] reliability | Complete broadcast logging trail

Hardened the logging path so diagnostic bundles can reconstruct an эфир from
session JSONL. Session filenames now include seconds, milliseconds, and a
counter to avoid rapid restart overwrites; `logger.flush()` runs before bundle
collection; `state_snapshot` records all open lots; and reservation JSONL now
separates early `reservation_detected` from final `reservation_finalized`
outcomes.

The bundle `INDEX.md` now counts accepted reservations from finalized
`reserved` / `reserved_appended` statuses instead of early comment detection,
with a legacy fallback for older `reservation_accepted` records. Updated
[[logging-and-diagnostics]] and [[testing-guide]].

## [2026-06-04] fix | VK comments live again — token routing reverted, self-ingestion closed

Log review of bundles `…2026-06-03T19-10` and `…19-44` (the эфир stopped
publishing comments and ingesting reservations).

**Root cause — supersedes the [2026-05-31] Stage 5 decision above.** That stage
routed `video.*` writes through a community-first `commentToken`. VK does not
allow video methods under a community token: once `VK_GROUP_TOKEN` was set (for
DMs) every `video.getComments` / `video.createComment` / `video.get` failed with
`error_code 27` ("Group authorization failed: method is unavailable with group
auth"). Comment polling and lot-card publishing died from 2026-06-02 on. Posting
service comments "from the community page" is simply not attainable for live
video — the user-token identity (account "Amber Standard") is the only option.
Fix: derive `videoToken = VK_USER_TOKEN || VK_GROUP_TOKEN || VK_ACCESS_TOKEN`
and use it for all `video.*` calls; the group token now serves only `messages.*`
(community DMs). Restores the pre-Stage-5 behaviour that last worked 2026-05-30.

**Self-comment re-ingestion (data-integrity bug).** The poller processed
comments authored by the bot's own VK account (id 816076245), so its reply
«… бронь подтверждена (код …)» was re-read as a fresh reservation from the bot
itself — bogus `out_of_stock`, phantom wishlist entries, and (at stock ≥2) would
have created a phantom MoySklad order on the bot account. Fix: resolve the bot's
own id via `vk.getSelfUserId()` (`users.get`, or `VK_SELF_USER_ID` override) and
skip comments where `from_id === selfUserId`. New `test/ws-server.self-comment.test.js`.

**Chat hygiene.** Dropped the internal `lotSessionId:` line from every published
comment (nothing parses it back); the lot card omits the price line when price
is 0 (operator names it by voice → `publishPriceUpdate` posts it), so no more
«Цена: 0 ₽» card.

**Operator UX.** Added a persistent voice cancel-command format hint to the
«Брони» panel. The parser stays strict (verb + «лот»/«бронь» + code, name
required) — deliberately not loosened on the money path. Shipped as v0.1.48/49.
Updated [[vk-comments]] and [[vk-integration]].

## [2026-06-08] fix | MoySklad reservation discounts stay in discount field

Fixed customer-order position payloads so discounted reservations send the
original item price in `price` and the calculated percentage in MoySklad's
`discount` field. MoySklad now owns the final `sum` calculation instead of the
integration pre-subtracting the discount from the price. Updated
[[moysklad-integration]].

## [2026-06-08] fix | Reservation orders scoped back to broadcast day

Fixed the 2026-06-08 audit finding where current broadcast reservations were
appended to old or already paid MoySklad customer orders. The hot path now
reuses only same-day `#Эфир <date>` orders, blocks append to `Оплачен` and
`Частично оплачен`, and keys the in-memory order cache by buyer plus broadcast
date. Also hardened counterparty fallback so a same-name MoySklad counterparty
with another VK ID is skipped instead of reused. Updated [[reservation-flow]],
[[moysklad-integration]], and [[operator-feedback]].

## [2026-06-08] parser | Product-code resolver handles missing leading zeroes

Added a shared product-code resolver for voice detection, manual code entry, and
reservation-attention diagnostics. Operator codes like `243` now resolve to the
single matching catalog code such as `00243`; ambiguous leading-zero matches are
rejected instead of guessed. `reservationAttention` now shows the resolved
catalog code while preserving the buyer's raw `originalCode`. Updated
[[live-commerce-flow]], [[reservation-flow]], and [[moysklad-integration]].

## [2026-06-08] reliability | Harden VK, MoySklad, and unknown-stock edges

Implemented the secondary-risk pass from the 2026-06-08 audit. VK comment
polling now has a 30-second grace window after the last lot closes, so late
between-lot bookings escalate to the operator instead of disappearing. MoySklad
GET calls retry transient read failures, but write calls still avoid generic
retry to prevent duplicate customer orders or positions. Unknown-stock first
reservations are serialized per lot, so simultaneous comments can consume only
one fallback slot. Updated [[vk-integration]], [[reservation-flow]], and
[[moysklad-integration]].

## [2026-06-08] analysis | Real MoySklad fields verified

Checked real MoySklad data read-only against the 2026-06-08 plan. Existing
customer-order positions confirm that `price` stores the base price in minor
currency units, `discount` stores a percentage, and `reserve` carries the
reserved quantity. Runtime appendability resolves real metadata states and
blocks `Оплачен` while allowing `Новый`; the configured counterparty `VK ID`
attribute exists as text metadata.

The same check exposed an open integration risk: real order positions include
`variant` assortments, while current product lookup and product-code cache query
only `entity/product`. Variant-only codes can be missed, and duplicate numeric
codes across variants and products can resolve to the wrong article. Recorded in
[[moysklad-integration]] and [[documentation-drift]].

## [2026-06-11] review | Full project review at 0.1.54

Reviewed the whole repository: architecture, security, tests, CI, and docs.
Suite is green (291/291) and the money paths (Бронь → customer order, safe
mode, crash recovery) are deliberately guarded. Key findings: the Auto Release
workflow cuts releases without running tests, so a red suite can still reach
the operator's Mac; `npm audit` flags one high (axios via the Yandex SDK,
clean fix available); with no `API_TOKEN` the API is open on the LAN while
`HOST` defaults to `0.0.0.0`; `ws-server.js` regrew to 3119 LOC even though
the WS integration scaffolding that blocked deeper splits now exists. The
variant-lookup risk from 2026-06-08 remains the top open correctness item.
Full write-up in [[../raw/project-review-2026-06-11|project-review-2026-06-11]];
linked from [[index]].

## [2026-06-11] fix | Review remediation: CI test gate, axios, LAN-auth warning

Fixed the actionable findings from
[[../raw/project-review-2026-06-11|project-review-2026-06-11]]. The Auto
Release workflow now runs a `test` job (`npm ci && npm test` on Node 22 with a
SpeechKit key placeholder) before the `release` job — a red suite can no
longer ship to the operator's Mac. `npm audit fix` bumped transitive axios to
1.17.0; audit is clean. `server/index.js` logs `WARN auth_disabled_on_lan` at
startup when `API_TOKEN` is unset and `HOST` is not loopback. README test
count updated (180 → 290+) and the CI gate documented; the "test command
exists" drift item in [[documentation-drift]] is resolved. Verified by running
the full suite without `.env` (CI conditions): 291/291 green.

## [2026-06-20] analysis | Voice control hardening plan

Reviewed the current voice-control pipeline and recorded a reliability plan in
[[voice-control-hardening-plan]]. Priority fixes are configurable SpeechKit EOU
pause, explicit catalogless mode, confirmation or undo for voice discounts,
voice-price observability, an STT benchmark harness for SpeechKit versus
Whisper, and staged extraction of voice orchestration out of `ws-server.js`.

## [2026-07-02] feature | Self-hosted MediaMTX stream panel (MVP), PR #8

Operator's VK Live had reliability problems. Landed an optional "Стрим" panel
as an alternative video path, independent of the existing VK-comment order
flow. New page [[stream-integration]] has the full design and deploy record;
summary here for the log trail.

**Infra.** MediaMTX (Docker, `bluenviron/mediamtx`) deployed on the shared
`cloud` host (cloud.ru — also runs auctionbot/pay-service/n8n; IP withheld
from wiki, see deploy notes)
with `cpus: 0.5` / `mem_limit: 512m` so a busy эфир can't starve the payment
service on the same box. Only RTMP (1935) + HLS (8888) + loopback-only API
(9997) are enabled; RTSP/WebRTC/SRT/MoQ off. Verified end-to-end with a
throwaway ffmpeg publish → `ready:true` → working HLS playlist → status
flips back on stop. `ufw` opened 1935/8888; **cloud.ru's own security-group
firewall still needs opening by the account owner** — noted but not done.

**Code.** `config.stream` (optional, hidden when unconfigured) +
`server/stream-status.js` (`getStreamStatus()`, mirrors `moysklad.js`'s
`fetchWithTimeout`) + two routes (`/api/stream/config`, `/api/stream/status`)
+ dashboard panel (RTMP/key/viewer-link fields with copy buttons, 5s-polled
live indicator). `npm test`: 311/311.

**Review (medium-effort, 8 finder angles + verify) found two priority bugs,
both fixed same day (fdb20fb):**
- `.col--right`'s `grid-template-rows` assumed the stream panel was always a
  grid item — broke the 50/50 "Брони"/"События" split for every deployment
  where the feature is unconfigured (the default), since the hidden panel
  drops out of grid flow but the CSS still declared 3 tracks. Fixed with
  `:has(#streamPanel:not([hidden]))`.
- `GET /api/stream/config` returned the MediaMTX publish password gated only
  by the *optional* `API_TOKEN` — with it unset (the shipped default),
  `/api/*` has no auth at all, so the credential was readable by anyone
  reaching the dashboard. Now fails closed: omits `publishUser`/`publishPass`
  (`credentialsHidden:true`) unless `API_TOKEN` is configured.

Five lower-severity findings (URL trailing-slash normalization, collapsed
error states hurting live-incident triage, a poll race with no in-flight
guard, an inconsistent error-response shape, a real prod IP pasted into the
wiki) left open as a PR comment for a follow-up pass — not blocking the MVP.
