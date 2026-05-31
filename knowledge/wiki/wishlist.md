# Wishlist

Wishlist is the buyer waiting-list and supplier-order draft workflow. It is
connected to [[operator-feedback]] and current runtime files.

## Current implementation

Backend responsibilities:

- `server/wishlist-store.js` stores append-only wishlist events in
  `logs/wishlist.jsonl`.
- `server/wishlist-submissions.js` stores submission drafts and group results
  in `logs/wishlist-submissions.json`.
- `server/http-server.js` exposes wishlist HTTP operations and computes stable
  group hashes.
- `server/log-bundle.js` and `server/bundle-index.js` include wishlist data in
  diagnostic bundles.
- `server/index.js` handles crash recovery and avoids automatic wishlist
  migration without explicit buyer confirmation.

UI responsibilities live in `web-ui/app.js` around `wishlistState`: draft ID,
supplier groups, archive cache, settings, suppliers, stores, pending submit
state, and debounced saves.

## Operator dashboard workflow

The dashboard can:

- show active wishlist count and old-entry badge;
- create a server-side draft with `/api/wishlist/draft`;
- edit quantities, buy prices, suppliers, and selection state inline;
- type supplier names for `Без поставщика` rows through a browser typeahead
  backed by cached MoySklad suppliers; the selected name resolves to
  `supplierId` before saving;
- save compatible draft edits in `localStorage` with the `wishlist_draft_`
  prefix;
- check whether selected entries already exist in open customer orders;
- create MoySklad purchase orders grouped by supplier and store;
- archive consumed or manually removed entries;
- edit wishlist settings such as default store, default supplier, old-entry
  threshold, VK notification flag, and purchase-order description template.

Purchase-order submission is idempotent through `wishlist-submissions`: a
completed draft replays cached purchase-order results instead of creating
duplicates.

## Buyer command

The intended explicit command is `список <код>`. [[operator-feedback]] records
that the system needs clearer buyer-facing explanation for this command.

Out-of-stock reservation attempts also create wishlist entries automatically:
when a buyer writes a valid reservation for a lot whose known stock is already
fully committed, `server/ws-server.js` calls `addWishlistFromComment` with
trigger `out_of_stock_reservation`. This is W5 from the 2026-05-30 operator
wishes: overflow demand should stay visible to the operator instead of being
lost.

W6 manual mode is intentionally silent for buyers. `out_of_stock` entries go
to the wishlist without a public VK reply; the operator handles follow-up
manually from the wishlist modal.

## Open UX requests

- Explain how to enter the waiting list.
- Keep waiting-list overflow quiet in VK comments; public `out_of_stock`
  replies are intentionally disabled for manual mode.
- Prefer VK direct messages when possible.

## Related pages

- [[reservation-flow]]
- [[operator-feedback]]
- [[logging-and-diagnostics]]
- [[runtime-stores]]
- [[http-api]]
