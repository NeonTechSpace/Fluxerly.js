// Logs through the SDK's own console output: FLUXERLY_DEBUG names an unknown category, so connecting the client prints
// an Info record to standard output and a Warn banner to standard error. The unreachable instance ends the connection attempt
import { createClient } from "@neontechspace/fluxerly"

const client = createClient({
    token: "supervisor-output-sdk-token",
    instance: { url: "http://127.0.0.1:1", allowInsecure: true },
    connection: { startupTimeoutMs: 30_000, maxStartupAttempts: 1 },
})
await client.connect()
await client.shutdown()
