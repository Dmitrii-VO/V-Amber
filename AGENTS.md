# Repository notes

Repo currently contains product spec only. No application code, package
manifests, CI, test config, or local agent config present at root.

# Source of truth

`Amberry_Voice_Technical_Specification.md` is current source of truth for
project scope and architecture.

Spec language is Russian. Preserve product terms and API names exactly when
adding code or docs.

# Product context

Project goal: voice-assisted live-commerce workflow for VK.

Main integrations named in spec:
- Yandex SpeechKit Streaming API for low-latency STT.
- YandexGPT 5 Lite as fallback LLM for spoken product code parsing.
- VK API LongPoll for comment intake and chat replies.
- MoySklad API for stock lookup and customer-order reservation.
- Telegram Bot API for operator notifications and control actions.

Planned stack from spec:
- TypeScript/Node.js for core logic.
- Optional Python only for audio-driver work.
- Local Web UI for microphone/session control.
- Redis for stock cache and realtime queue/state.
- Docker for cross-platform deployment.

# Working rules for future sessions

Do not invent build, test, lint, or run commands until repo adds executable
config.

If implementation starts, infer command flow from manifests and config before
editing this file.

If docs or code conflict with spec later, trust executable config and update
this file with verified commands and boundaries.
