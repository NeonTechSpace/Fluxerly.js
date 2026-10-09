---
"@neontechspace/fluxerly": patch
---

The children of a supervisor now share the Fluxer limits that apply to the whole bot account, in both APIs. When one child is rate-limited globally, the parent holds the other children's REST requests until the same time, so they no longer keep sending into the pause and collect more 429 responses. Member requests from all children share the member request limit through the parent. A child that gets no answer from its parent within one second counts only its own member requests and logs `supervisor.memberRequestsLocal` at Warn once. Per-route rate limits stay with each child. A client's first REST request also no longer waits out a global pause while it discovers the Fluxer instance, so it fails at once when the pause outlasts its deadline
