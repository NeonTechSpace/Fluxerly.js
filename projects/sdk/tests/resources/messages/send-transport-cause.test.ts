import { afterEach, expect, test, vi } from "vitest"
import type { MessageError } from "../../../src/index.js"
import { describeBothApis, setup } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { expectErr } from "../../support/settle.js"

afterEach(() => {
    vi.unstubAllGlobals()
})

// A lost send or reply connection is the case where callers most need the underlying transport code
describeBothApis("send transport failures", (mode) => {
    test.each(["send", "reply"] as const)(
        "%s keeps the sanitized transport failure as the MessageError cause",
        async (kind) => {
            const fetch = stubFetchWithHostedDiscovery(() =>
                Promise.reject(
                    Object.assign(new Error("socket hang up at https://example.invalid/?token=secret"), {
                        code: "ECONNRESET",
                    }),
                ),
            )
            const client = await setup(mode)
            const error = (await expectErr(
                kind === "send"
                    ? client.messages.send("20", { content: "hello" })
                    : client.messages.reply({ channelId: "20", id: "30" }, { content: "hello" }),
            )) as MessageError
            expect(fetch).toHaveBeenCalled()
            expect(error._tag).toBe("MessageError")
            expect(error.reason).toBe("network")
            expect(error.cause).toBeInstanceOf(Error)
            const cause = error.cause as Error & { readonly code?: string }
            expect(cause.name).toBe("TransportError")
            expect(cause.code).toBe("ECONNRESET")
            // The transport message can carry URLs or credentials, so only the code survives
            expect(cause.message).not.toContain("secret")
        },
    )
})
