import { afterEach, expect, test, vi } from "vitest"
import { modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { startRestServer } from "../support/rest-server.js"
import { expectErr, settle, type Operation } from "../support/settle.js"

const realFetch = globalThis.fetch

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** Fluxer's header decoding: A value of only Latin-1 characters with a high byte is read as UTF-8 bytes, otherwise kept
 * (AuditLogMiddleware.ts:11-30 at 5f3fc0b1)
 */
function fluxerDecode(value: string): string {
    let high = false
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code > 0xff) return value
        if (code >= 0x80) high = true
    }
    if (!high) return value
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"))
    } catch {
        return value
    }
}

/** A loopback server reached through the hosted API address, so the header crosses a real HTTP connection */
async function loopback() {
    const rest = await startRestServer({ fallback: (_request, response) => void response.writeHead(204).end() })
    stubFetchWithHostedDiscovery((url, init) => realFetch(url.replace("https://fluxer.com/api", rest.origin), init))
    // Node reads received header bytes as Latin-1 text, as Fluxer's server does
    return () => rest.requests.map((request) => request.headers["x-audit-log-reason"])
}

test.each(modes)("%s sends a Unicode audit reason as UTF-8 bytes that Fluxer decodes back", async (mode) => {
    const received = await loopback()
    const api = await setup(mode)
    const unicode = "Belästigung 日本 😀"
    const longest = "😀".repeat(256)
    await settle(api.members.kick({ guildId: "20", userId: "30" }, { auditReason: `  ${unicode}  ` }))
    await settle(api.webhooks.delete("100", { auditReason: longest }))
    await settle(api.rest.request({ method: "DELETE", path: "/guilds/20/bans/30", auditReason: unicode }))
    await settle(api.members.kick({ guildId: "20", userId: "30" }, { auditReason: "  routine ASCII reason  " }))

    const headers = received()
    expect(headers.map((value) => fluxerDecode(String(value)))).toEqual([
        unicode,
        longest,
        unicode,
        "routine ASCII reason",
    ])
    // An ASCII reason stays byte-identical on the wire
    expect(headers[3]).toBe("routine ASCII reason")
})

test.each(modes)("%s rejects audit reasons Fluxer cannot store before dispatch", async (mode) => {
    const received = await loopback()
    const api = await setup(mode)
    const format = ["tab\there", "line\nbreak", "delete\u007f", "next\u0085line", "line separator", "lone \ud800"]
    const length = ["", "   ", "😀".repeat(256) + "x", "x".repeat(513)]
    for (const [reasons, constraint] of [
        [format, "format"],
        [length, "length"],
    ] as const)
        for (const auditReason of reasons) {
            for (const operation of [
                api.members.kick({ guildId: "20", userId: "30" }, { auditReason }),
                api.webhooks.delete("100", { auditReason }),
            ] as Operation<void, unknown>[])
                expect(await expectErr(operation)).toMatchObject({
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: { path: "options.auditReason", constraint },
                })
            const raw = await expectErr(api.rest.request({ method: "DELETE", path: "/guilds/20/bans/30", auditReason }))
            expect(raw).toMatchObject({ reason: "input", outcome: "notDispatched" })
            // Reasons are application text and stay out of SDK errors
            expect(JSON.stringify(raw)).not.toContain(auditReason.trim() || "\u0000")
        }
    expect(received()).toEqual([])
})
