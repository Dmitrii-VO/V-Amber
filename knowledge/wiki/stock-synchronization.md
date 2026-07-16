# Stock synchronization

Stock synchronization keeps visible available stock aligned with MoySklad after
reservations and lot changes.

## Current knowledge

- Operator feedback from 2026-05-24 says visible stock did not change after a
  reservation.
- Unknown stock, represented as `availableStock=null`, can weaken duplicate and
  oversell protection.
- The UI and active reservation state need refresh after MoySklad order
  position creation.
- **Confirmed instance, 2026-07-05 эфир**: cross-checking `find-overbooked.js`
  against the session log, all 4 products it found overbooked by exactly `-1`
  (03304, 00969, 03300, 01277) had `lot_opened.availableStock: null` — the
  stock gate had nothing to check against, so the single reservation on each
  went through and tipped an already-zero/near-zero item negative. Every other
  lot opened that эфир had a real `availableStock` number and none of those
  overbooked. Read: `null` at `lot_opened` is the leading indicator to watch
  for mid-broadcast, not a rare edge case — it reliably correlates with a
  post-hoc overbook. See [[log-verification-checklist]] step 7.

## Runtime files

- `server/ws-server.js`
- `server/moysklad.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[reservation-flow]]
- [[moysklad-integration]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
