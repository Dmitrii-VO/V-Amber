# Analytics tracking plan

This page defines a minimal measurement contract for V-Amber. The current
runtime has no analytics SDK, no GTM container, and no `dataLayer` events in
`web-ui/` as of June 1, 2026. Treat this page as the source plan for a future
implementation, not as evidence that tracking is already live.

## Overview

Use this overview to decide whether analytics work belongs in the current local
runtime or in a later third-party measurement layer.

- Tools: none installed. Recommended first implementation: server-side JSONL
  operational analytics plus optional GA4/GTM only if external marketing
  attribution becomes necessary.
- Product surface: local operator dashboard served from `web-ui/` by
  `server/http-server.js`.
- Primary decisions: whether operators complete live sessions successfully,
  where reservations or wishlist flows fail, and which safe-mode or integration
  states block revenue-producing work.
- Privacy boundary: do not send buyer names, VK IDs, phone numbers, order
  names, tokens, or raw comments to third-party analytics.

## Current state

The repo search found no active analytics implementation. Existing operational
evidence comes from application logs, session JSONL, reservation digest logs,
and runtime state under `logs/`, which remains ignored source material rather
than code.

Because this is an internal operator tool, the highest-value implementation is
event tracking for workflow reliability and conversion completion. Marketing
site events and UTM attribution are low priority until V-Amber has a public
acquisition funnel.

## Events

Use lowercase event names with object-action naming. Keep product terms and
external API names exact in properties.

### Common envelope

Every event must include a small non-PII envelope so JSONL records can be
joined, deduplicated, and reconciled with diagnostic bundles.

| Field | Description |
|---|---|
| `event_id` | Random UUID generated once per emitted event. |
| `event_name` | One of the documented event names. |
| `timestamp` | ISO-8601 client or server timestamp for when the event happened. |
| `session_id` | Runtime stream/session identifier when available. |
| `app_version` | Package version reported by the running app. |
| `install_id` | Local install UUID from `server/install-id.js`; never use buyer identifiers. |
| `source_surface` | `web-ui`, `server`, or another coarse emitting surface. |

### Event catalog

This catalog lists the first events worth implementing. Add new rows only when
they answer an operator workflow, conversion, or reliability question.

| Event name | Description | Properties | Trigger |
|---|---|---|---|
| `stream_started` | Operator starts a live audio stream. | `safe_mode`, `has_vk_url`, `microphone_device_present`, `cache_refresh_choice` | `startStreaming()` reaches streaming state. |
| `stream_stopped` | Operator stops a live audio stream. | `duration_seconds`, `lot_count`, `reservation_count`, `reservation_revenue_kopecks` | `stopStreaming()` completes. |
| `stream_start_failed` | Stream setup fails before audio reaches the backend. | `failure_stage`, `safe_mode`, `error_code` | `startStreaming()` catches setup errors. |
| `websocket_disconnected` | Dashboard loses the audio WebSocket unexpectedly. | `lifecycle`, `was_streaming` | WebSocket close handler outside normal stop. |
| `safe_mode_toggled` | Operator changes safe mode. | `enabled`, `source` | `safeModeToggle` changes. |
| `product_cache_refresh_requested` | Operator requests MoySklad product-code cache refresh. | `remembered_choice`, `result` | Cache banner load path or refresh API call. |
| `lot_detected` | A product lot becomes active from speech or manual code. | `product_code_present`, `source`, `stock_state` | Active lot changes. |
| `lot_closed` | Operator closes the active or open lot manually. | `lot_age_seconds`, `had_reservations`, `source` | `closeLot` WS message. |
| `lot_price_overridden` | Operator edits the active lot price. | `had_voice_price`, `sale_price_kopecks` | `setLotPrice` WS message. |
| `manual_code_submitted` | Operator submits a manual article code. | `code_length`, `result` | `manualCodeForm` submit path. |
| `reservation_confirmed` | A buyer reservation is confirmed. | `quantity`, `safe_mode`, `stock_state`, `source` | Reservation event enters UI state. |
| `reservation_cancelled` | Operator cancels a confirmed reservation. | `safe_mode`, `result` | `cancelReservation` WS path. |
| `digest_preview_loaded` | Operator previews reservation digest recipients. | `date`, `client_count`, `position_count` | `/api/reservation-digests/preview` succeeds. |
| `digest_messages_sent` | Operator sends VK digest messages. | `date`, `selected_client_count`, `sent_count`, `failed_count` | `/api/reservation-digests/send` returns. |
| `wishlist_opened` | Operator opens the wishlist modal. | `active_count`, `old_entry_count` | Wishlist button click. |
| `wishlist_manual_entry_added` | Operator manually adds a wishlist entry. | `quantity`, `has_viewer_name`, `result` | `/api/wishlist/entries` returns. |
| `wishlist_customerorders_checked` | Operator checks wishlist entries against open customer orders. | `entry_count`, `matched_count`, `failed_count` | `/api/wishlist/check-customerorders` returns. |
| `wishlist_purchase_order_created` | Operator creates supplier purchase orders from wishlist. | `group_count`, `entry_count`, `fallback_supplier_used`, `result` | `/api/wishlist/purchase-order` returns. |
| `wishlist_settings_saved` | Operator saves wishlist defaults. | `has_default_store`, `has_default_supplier`, `notify_vk_on_add` | `/api/settings` wishlist patch succeeds. |

## Custom dimensions

Prefer coarse dimensions that explain workflow state without leaking customer
data.

| Name | Scope | Parameter |
|---|---|---|
| `safe_mode` | Event | `safe_mode` |
| `lifecycle` | Event | `lifecycle` |
| `source` | Event | `source` |
| `stock_state` | Event | `stock_state` |
| `failure_stage` | Event | `failure_stage` |
| `result` | Event | `result` |

## Conversions

These conversions answer whether the live-commerce workflow produced useful
operator outcomes.

| Conversion | Event | Counting |
|---|---|---|
| Successful live session | `stream_stopped` with `reservation_count > 0` | Once per stream. |
| Confirmed reservation | `reservation_confirmed` | Every event. |
| Digest sent | `digest_messages_sent` with `sent_count > 0` | Once per send attempt. |
| Supplier order created | `wishlist_purchase_order_created` with success result | Once per draft submission. |

## Implementation notes

Start with an internal analytics module instead of a third-party script. A
small client helper can POST event envelopes to a backend endpoint, and the
backend can append redacted events to a dedicated JSONL file under `logs/`.
That keeps measurement useful in local deployments and avoids adding a consent
or external-network dependency to the operator dashboard.

If GA4 or GTM is added later, route only redacted events through the same
helper. Gate third-party sends behind explicit configuration and consent
requirements, and keep the local JSONL path as the debugging source of truth.

## Validation checklist

Use this checklist before treating any implementation as production-quality
measurement.

- Events fire once on the intended trigger.
- Required properties are present and use stable names.
- No buyer PII, VK identifiers, raw comments, tokens, or order names leave the
  app.
- Safe mode and failed external writes are visible in event properties.
- Session-level totals match the dashboard recap after stopping a stream.
- Wishlist and digest success counts match the backend API response.
