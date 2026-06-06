# Project knowledge index

This index is the entry point for the V-Amber Obsidian project wiki. Read it
before answering project-context questions, and update it whenever wiki pages
change.

## Orientation

- [[project-overview]] — What V-Amber does, source-of-truth order, and current
  MVP boundaries.
- [[repo-map]] — High-signal map of backend, web UI, scripts, tests, runtime
  files, and docs.
- [[project-conventions]] — Tech stack, agent conventions, Obsidian workflow,
  and durable coding practices.
- [[obsidian-knowledge-base]] — How this repository uses Obsidian and the
  Karpathy-style LLM wiki workflow.
- [[obsidian-plugins-guide]] — Plugin workflow copied from the Amberry39 vault
  pattern.

## Runtime and infrastructure

- [[runtime-architecture]] — Local Node.js runtime, HTTP/WebSocket split,
  browser audio flow, state stores, and logs.
- [[runtime-stores]] — Active state, settings, wishlist, submissions, and
  reservation-digest persistence under `logs/`.
- [[configuration-and-secrets]] — Runtime variable groups, required SpeechKit
  key, optional integrations, and secret-handling notes.
- [[operational-commands]] — Confirmed commands for install, runtime, Docker,
  tests, and service scripts.
- [[http-api]] — Local browser UI and operator HTTP endpoints.
- [[web-dashboard]] — Browser operator dashboard features and client-side
  workflows.
- [[release-process]] — Version tags, GitHub release workflow, startup version
  check, and update path.
- [[macos-launchers]] — Double-click startup and update scripts for macOS.
- [[testing-guide]] — Current Node test entry point and focused test files.
- [[documentation-drift]] — Places where README, AGENTS, or other docs need to
  be synchronized with the current tree.
- [[deferred-operator-features]] — Design records for the operator-audit
  items that needed WS integration test scaffolding before landing (#14
  manual code entry, #16 cancel reservation). Both have landed; no deferred
  items remain.

## Product and business flows

- [[live-commerce-flow]] — Operator speech, product lookup, active lot, VK card,
  and reservations.
- [[reservation-flow]] — VK `бронь`, stock checks, waitlist state, MoySklad
  customer orders, and safe mode behavior.
- [[wishlist]] — Buyer waiting list and supplier-order draft workflow.
- [[operator-feedback]] — Durable operator requests collected from test
  sessions.
- [[voice-price-parsing]] — Spoken price extraction and compact digit phrases.
- [[stock-synchronization]] — Visible stock refresh and known unknown-stock
  risks.
- [[vk-comments]] — Buyer command channel, service replies, and comment noise.
- [[preorders]] — Planned preorder workflow from `TODO.md`.

## Integrations

- [[speechkit-integration]] — Yandex SpeechKit Streaming API usage.
- [[vk-integration]] — VK live URL, publication, comment polling, replies, and
  API backoff.
- [[moysklad-integration]] — Product lookup, stock, counterparties, orders,
  reservations, product-code cache, and diagnostic scripts.

## Operations

- [[runbooks-and-troubleshooting]] — Common local diagnostics and known failure
  modes.
- [[logging-and-diagnostics]] — JSON logs, Markdown session logs, JSONL state,
  diagnostic bundle, and install ID.
- [[analytics-tracking-plan]] — Measurement contract for operator workflow,
  conversion, and reliability analytics.
- [[service-scripts]] — One-off diagnostic and recovery scripts.
- [[reservation-digests]] — VK DM summaries for open live-commerce reservations.

## Source snapshots

- [[../raw/project-wiki-ingest-2026-05-24|project-wiki-ingest-2026-05-24]] —
  Source list for the initial V-Amber wiki population and Amberry39-structure
  migration.
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]] —
  Source summary from the 2026-05-24 operator test session.
- [[../raw/log-review-2026-06-05-plan|log-review-2026-06-05-plan]] — Findings and
  implementation plan from the 2026-06-05 broadcast log review (VK photo
  fallback, adaptive poll + queue priority, day-agnostic order merge, reservation
  escalation, discount tests). Implemented 2026-06-06.
