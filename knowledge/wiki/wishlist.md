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
- `server/index.js` handles crash recovery: safe unfinished reservation states
  migrate automatically, while uncertain `creating_order` stays for manual
  MoySklad reconciliation.

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
duplicates. That cache is written *after* MoySklad answers, so it cannot cover
a lost response — the `createPurchaseOrder` call is additionally journaled under
`po::${draftId}::${groupHash}` in the MoySklad write journal, which is what
stops a re-submitted group from producing a second purchase order. See
[[runtime-stores]].

## Buyer command

The intended explicit command is `список <код>`. [[operator-feedback]] records
that the system needs clearer buyer-facing explanation for this command.

Out-of-stock reservation attempts also create wishlist entries automatically:
when a buyer writes a valid reservation for a lot whose known stock is already
fully committed, `server/ws-server.js` calls `addWishlistFromComment` with
trigger `out_of_stock_reservation`. This is W5 from the 2026-05-30 operator
wishes: overflow demand should stay visible to the operator instead of being
lost.

Since the 2026-08-04 incident fix, successful `out_of_stock` and close-time
migrations notify buyers in the channel where the request originated. The reply
states that the buyer was added to the waiting list. If wishlist persistence
fails, the reply reports the failure instead of claiming success. Requested
`quantity` is preserved in the wishlist entry.

## Open UX requests

- Explain how to enter the waiting list.
- Prefer VK direct messages when possible.

## Related pages

- [[reservation-flow]]
- [[operator-feedback]]
- [[logging-and-diagnostics]]
- [[runtime-stores]]
- [[http-api]]
