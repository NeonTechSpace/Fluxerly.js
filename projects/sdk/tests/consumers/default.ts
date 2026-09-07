import { createClient, type Client, type ConnectionState } from "@neontechspace/fluxerly"

export function createAndReadState(token: string): ConnectionState | "ConfigurationError" {
    return createClient({ token }).match(
        (client) => client.state,
        (error) => error._tag,
    )
}

export function rejectedTypeShapes(client: Client): void {
    // @ts-expect-error The credential is required
    createClient({})
    // @ts-expect-error Credentials must be strings
    createClient({ token: 42 })
    // @ts-expect-error Only the SDK may change connection state
    client.state = "Connected"
    // @ts-expect-error Native Effect composition is not part of the default operation result
    client.connect().pipe()
    // @ts-expect-error Connection policy is client-wide, not a per-call override
    client.connect({ startupTimeoutMs: 1 })
}

export async function manageClient(token: string): Promise<void> {
    const created = createClient({ token, connection: { startupTimeoutMs: 30_000, maxStartupAttempts: 3 } })
    if (created.isErr()) return
    const result = await created.value.run()
    if (result.isErr() && result.error._tag === "RateLimitError") {
        const delay: number | null = result.error.retryAfterMs
        void delay
    }
}
