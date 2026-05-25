# Reservation flow

Reservation flow handles buyer comments such as `бронь` during an active VK
lot.

## Active lot state

`server/ws-server.js` owns the active lot, accepted users, primary reservation,
waitlist event status, customer-order session version, and safe mode broadcasts.
Before changing this flow, trace those values together.

## Stock protection

The flow checks the active lot's `product.availableStock` against already
creating and confirmed reservation events before writing to MoySklad. Later
`бронь` comments do not oversell the current lot when stock is known.

If stock is unknown, a reservation can still pass. [[operator-feedback]] notes
that this raises duplicate-risk and needs operational care. See
[[stock-synchronization]].

## MoySklad write path

For a valid reservation, the backend ensures or finds a counterparty and then
creates or appends a customer order in MoySklad. Safe mode wraps external write
methods so dry runs still log detected events without creating real external
state.

Customer-order merging is scoped to the broadcast day. The first reservation
from a buyer on a calendar day creates a new MoySklad customer order with a
daily marker such as `#Эфир 2026-05-24`. Later reservations from the same buyer
on the same day append only to an order with the same marker. Older open orders
without that marker, including unpaid `Новый` orders, must stay separate.

## Waitlist and recovery

While one reservation is being processed, later comments can wait. Startup
recovery writes orphan reservation evidence to session logs and does not
auto-migrate those users into [[wishlist]] without explicit confirmation.

## Related pages

- [[moysklad-integration]]
- [[vk-integration]]
- [[vk-comments]]
- [[logging-and-diagnostics]]
- [[preorders]]
