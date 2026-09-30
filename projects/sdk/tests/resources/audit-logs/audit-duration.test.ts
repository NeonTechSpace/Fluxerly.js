import { afterEach, expect, test, vi } from "vitest"
import { AuditLogActions } from "../../../src/index.js"
import { modes, setup } from "../../support/both-apis.js"
import { hostedDiscoveryDocument } from "../../support/hosted-discovery.js"
import { startSynchronousGateway } from "../../support/messages-gateway.js"
import { expectErr, settle } from "../../support/settle.js"
import { wsTarget } from "../../support/ws-redirect.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => {
    vi.unstubAllGlobals()
    wsTarget.sockets = []
})
const entry = (seconds: number | string) => ({
    id: "70",
    action_type: AuditLogActions.MemberBanAdd,
    user_id: "30",
    target_id: "40",
    options: { delete_message_seconds: seconds },
})

test.each(modes)("%s rejects unsafe audit milliseconds without projecting partial REST entries", async (mode) => {
    let seconds = 1e308
    const client = await setup(mode, {
        transport: {
            fetch: async (url) =>
                url.endsWith("/.well-known/fluxer")
                    ? Response.json(hostedDiscoveryDocument)
                    : Response.json({ audit_log_entries: [entry(seconds)], users: [], webhooks: [] }),
        },
    })
    for (seconds of [1e308, Number.MAX_SAFE_INTEGER / 1000 + 1]) {
        expect(await expectErr(client.auditLogs.fetchPage("20", { userId: "30" }))).toMatchObject({
            reason: "response",
        })
    }
    // Decimal seconds that are whole milliseconds must survive binary floating point, such as 1.1 * 1000
    for (const [value, ms] of [
        [0.001, 1],
        [1.1, 1_100],
        [604_800, 604_800_000],
    ] as const) {
        seconds = value
        const page = await settle(client.auditLogs.fetchPage("20", { userId: "30" }))
        expect(page.entries[0]!.options!.deleteMessagesMs).toBe(ms)
    }
})

test.each(modes)(
    "%s treats unsafe gateway audit milliseconds as a malformed dispatch",
    async (mode) => {
        const gateway = await startSynchronousGateway({ heartbeatIntervalMs: 600_000 })
        const client = await setup(mode, {
            gateway: { onMalformedDispatch: "terminate" },
            transport: {
                fetch: async (url) =>
                    url.endsWith("/.well-known/fluxer")
                        ? Response.json(hostedDiscoveryDocument)
                        : Response.json({ url: "wss://gateway.fluxer.app" }),
            },
        })
        await settle(client.connect())
        gateway.deliverNow("GUILD_AUDIT_LOG_ENTRY_CREATE", { ...entry(1e308), guild_id: "20" })
        expect(await expectErr(client.waitForClose())).toMatchObject({ reason: "protocol" })
        expect(client.state).toBe("Closed")
    },
    1000,
)
