---
aliases:
  - V-Amber
  - Amberry Voice
---

# Project overview

V-Amber, also called Amberry Voice, is an MVP voice-assisted live-commerce
workflow for VK. The browser panel records the operator's speech, the local
server recognizes it through Yandex SpeechKit, extracts a product code, opens
an active lot, publishes a VK lot card, and processes buyer comments such as
`бронь`.

## Source of truth

Use these sources first:

- `Amberry_Voice_Technical_Specification.md` for product scope, business rules,
  and Russian terminology.
- Current code when implementation details or runtime behavior matter.
- `README.md` for user-facing MVP overview.
- `AGENTS.md` for agent rules and repository-specific guardrails.
- `TODO.md` for planned work and temporary product notes.
- This wiki for durable synthesized knowledge and navigation.

When docs and code disagree, trust current code for implementation details and
record the mismatch in [[documentation-drift]].

## Current state

The project is no longer spec-only. The repository contains a runnable Node.js
MVP with:

- backend on Node.js ES Modules;
- static browser UI for microphone control and session status;
- WebSocket audio streaming from browser to backend;
- Yandex SpeechKit Streaming API integration;
- VK comment polling and lot-card publication;
- MoySklad product lookup, customer orders, and reservation handling;
- safe mode for dry runs;
- JSON, JSONL, and Markdown diagnostic logs;
- Docker packaging for local runtime.

## MVP boundaries

Redis, SQLite, TypeScript, and Python audio-driver code appear in the product
specification as planned architecture, but they are not part of the current
runtime. The current architecture is described in [[runtime-architecture]].

## Important links

- [[live-commerce-flow]]
- [[reservation-flow]]
- [[wishlist]]
- [[preorders]]
- [[operational-commands]]
- [[documentation-drift]]
