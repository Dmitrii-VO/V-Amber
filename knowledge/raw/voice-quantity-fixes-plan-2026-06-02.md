# Voice-quantity (+N шт) hardening — fix plan (2026-06-02)

Source: comprehensive review of the voice-quantity feature (commits `820b502`
+ `cdde3c2`). Six findings, fixed across the phases below on branch
`fix/voice-quantity-hardening`. Related wiki: [[reservation-flow]]
("Voice quantity (+N шт)", "Stock protection"), [[documentation-drift]].

## Findings → phases

| # | Severity | Finding | Phase |
|---|----------|---------|-------|
| 1 | HIGH | Confirm button `+N шт` is destroyed by any `emitState` re-render; `renderReservationsForLots` rebuilds rows without re-creating it. | 1 |
| 3 | MED | Failed append consumes the one-shot token at handler start → button stuck on «…», retry impossible by click. | 2 |
| 2 | MED | Voice append skips the stock guard the rest of the flow enforces → oversell. **Decision: operator-always-right (intentional override), document it.** | 5 |
| 4 | LOW | Hard cap silently reduces quantity (20→10) with no operator feedback. | 3 |
| 5 | LOW | Word quantities above «десять» don't match at all → silent no-op. | 3 (parser) |
| 6 | LOW | Digit-word code truncates on a mid-number filler («ноль три ну два» → "03"). | 4 (parser) |

## Phase 1 — UI: persist pending button across re-renders (fix #1)

- `state.pendingQuantity`: `Map` keyed `${viewerId}:${commentId}` → `{ actionId,
  quantity, requested, capped, code, lotSessionId, viewerName, spokenName,
  expiresAt }`.
- `highlightReservationForQuantity` writes the entry (single pending at a time),
  then re-renders so the button comes from state, not one-shot DOM.
- `renderReservationsForLots` re-applies highlight + `+N шт` button from
  `state.pendingQuantity` per row (mirrors how the cancel button is rebuilt).
  Skips/prunes expired entries (60 s client TTL, mirrors server).

## Phase 2 — Token lifetime + typed ack (fix #3)

- Server: `consumePendingQuantityAction` → `peek` (no delete). Delete the token
  only after a successful `addReservationEvent`. Double-submit stays blocked by
  `event.appendInFlight`.
- Server: new WS message `voiceQuantityResult { actionId, ok, reason? }` — `ok:true`
  on success, `ok:false` on every warning/failure branch of the append handler.
- Client: handle `voiceQuantityResult` — `ok:true` → delete map entry + re-render
  (button gone); `ok:false` → re-render (re-enabled button from live entry).

## Phase 3 — Surface clamp + understand «двадцать» (fix #4, parser-side #5)

- Parser returns `{ quantity, requested }` (`requested` = pre-clamp value).
- Parser `QUANTITY_WORDS` extended with 11–20, tens, «сто» → they parse and clamp
  instead of silent `matched:false`.
- Server: `capped = requested > quantity`; include `requested`/`capped` in
  `voiceQuantityMatch`.
- UI: confirm dialog + log show requested-vs-applied when `capped`.

## Phase 4 — Robust digit-word code (fix #6)

- `extractCode` digit-word loop skips interspersed filler/noise tokens (bounded)
  instead of breaking at the first gap; stops only on a real word.

## Phase 5 — Docs: operator-always-right + Obsidian sync (fix #2)

- No stock guard added to voice append — deliberate operator override.
- Code comment at the append handler before the `committedReservationCount` bump.
- `reservation-flow.md`: "Stock protection" caveat (guard is buyer-`бронь` only;
  operator voice-append intentionally bypasses it), and "Voice quantity (+N шт)"
  gains an operator-override paragraph + `voiceQuantityResult` + client button
  persistence notes.
- `documentation-drift.md`: note the voice-append exception.

## Phase 6 — Tests

- Parser unit tests (Phases 3, 4).
- New `test/ws-server.append-quantity.test.js`: success, stale/reused actionId,
  TTL expiry, safe-mode block, MoySklad throw → `ok:false` + token still alive,
  `committedReservationCount` bump.
- `npm test` green.
