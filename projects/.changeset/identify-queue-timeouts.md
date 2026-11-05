---
"@neontechspace/fluxerly": minor
---

When `connection.startupTimeoutMs` and `connection.recovery.attemptTimeoutMs` are left at their 30,000 ms defaults, sending Identify now extends the deadline by 135,000 ms. Fluxer may hold an Identify in its queue for up to 60 seconds and gives a session start up to 135 seconds, as during a gateway rollout, so a 30-second attempt could give up on a session Fluxer would still start and then queue again from the back. Under heavier load Fluxer holds such an Identify and retries it itself while the connection stays open. Startup gets the extension once, when its first Identify is sent, and each recovery attempt gets it when it sends Identify. Discovery, the socket, HELLO and a Resume keep the 30-second deadline, since Fluxer imposes no such wait on them, and so does automatic sharding's community count. A value the caller sets stays one fixed deadline that Identify does not extend
