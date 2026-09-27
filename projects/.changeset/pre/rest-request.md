---
"@neontechspace/fluxerly": minor
---

Add `client.rest.request({ method, path, query?, body?, files?, auditReason?, timeoutMs? })` for Fluxer API routes without an SDK method.
Default calls return a `ResultAsync` and accept `signal`, and Effect calls return an Effect. Both resolve with `{ status, headers, body }`, where header names are lower case and `body` is the parsed JSON body or `undefined` for an empty response.
Requests use the client's credential, queue, learned rate-limit buckets, 429 waits, deadline, logging and bounded GET retries. Other methods are sent again only after a confirmed 429, never after an uncertain outcome.
Paths must be relative API paths such as `/users/@me`, without a scheme, host, query, fragment, dot segments or the `/v1` prefix. Token-authenticated webhook routes are rejected because their credential is part of the path.
Invalid input fails with `RestRequestError` reason `input` before any request, a non-2xx status fails with `RestRequestError` carrying the status and sanitized `apiError`, and a request after shutdown fails with `ClientClosedError`. Logs, metrics and spans show only a route template in which IDs, codes and other non-word segments are placeholders.
The `files` field accepts the message attachment inputs and sends them inline as multipart form data with their metadata in `payload_json`
