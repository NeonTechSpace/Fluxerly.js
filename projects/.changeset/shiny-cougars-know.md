---
"@neontechspace/fluxerly": patch
---

Align request text validation with Fluxer's field-specific normalization and UTF-16 limits without rewriting accepted input

Preserve global rate-limit pauses when error bodies are unavailable and learn server rate-limit buckets with bounded, resource-aware tracking

Bound complete gateway messages before decoding, including fragmented frames, and reject invalid UTF-8 through the transport

Keep attachment reads responsive to cancellation and deadlines when sources repeatedly yield empty chunks

Use ordinary JavaScript and TypeScript extensions inside ESM package scopes while retaining the existing public package entry points
