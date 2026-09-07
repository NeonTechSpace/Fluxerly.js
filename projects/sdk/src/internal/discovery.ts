import { Effect, Redacted } from "effect"
import { AuthenticationError, ConnectionError, RateLimitError, type ConnectionFailure } from "#sdk/errors"

/** Hosted Fluxer only; discovery is not proof that the credential is valid */
export const discoverGateway = (token: Redacted.Redacted<string>) =>
    Effect.tryPromise({
        try: async (signal) => {
            const response = await fetch("https://api.fluxer.app/v1/gateway/bot", {
                headers: { Authorization: `Bot ${Redacted.value(token)}` },
                redirect: "error",
                signal,
            })
            try {
                if (response.status === 401 || response.status === 403) throw new AuthenticationError()
                if (response.status === 429) {
                    const header = response.headers.get("retry-after")
                    let delay = header === null ? NaN : Number(header) * 1000
                    if (header !== null && !Number.isFinite(delay)) delay = Date.parse(header) - Date.now()
                    // Fluxer's retry_after body field is in seconds; never shorten a header wait
                    const body: unknown = await response.json().catch(() => null)
                    if (
                        typeof body === "object" &&
                        body !== null &&
                        "retry_after" in body &&
                        typeof body.retry_after === "number"
                    ) {
                        const bodyDelay = body.retry_after * 1000
                        if (Number.isFinite(bodyDelay) && bodyDelay >= 0)
                            delay = Math.max(Number.isFinite(delay) ? delay : 0, bodyDelay)
                    }
                    throw new RateLimitError("http", Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null)
                }
                if (!response.ok) throw new ConnectionError("discovery", "network", response.status)
                const body: unknown = await response.json()
                if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
                    throw new ConnectionError("discovery", "protocol")
                }
                let url: URL
                try {
                    url = new URL(body.url)
                } catch {
                    throw new ConnectionError("discovery", "protocol")
                }
                // Do not send a credential to an arbitrary host returned by discovery
                if (
                    url.protocol !== "wss:" ||
                    url.hostname !== "gateway.fluxer.app" ||
                    url.port ||
                    url.username ||
                    url.password ||
                    url.hash
                ) {
                    throw new ConnectionError("discovery", "protocol")
                }
                url.search = "?v=1&encoding=json"
                return url.href
            } finally {
                if (!response.bodyUsed) await response.body?.cancel()
            }
        },
        catch: (error): ConnectionFailure =>
            error instanceof AuthenticationError || error instanceof ConnectionError || error instanceof RateLimitError
                ? error
                : new ConnectionError("discovery", "network"),
    })
