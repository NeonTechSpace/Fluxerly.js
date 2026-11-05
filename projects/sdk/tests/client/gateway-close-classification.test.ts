import { describe, expect, test } from "vitest"
import { AuthenticationError, ConnectionError, RateLimitError } from "../../src/errors.js"
import { classifyClose, closeReasonText } from "../../src/internal/gateway/session.js"
import { closeCodeInfo, opcodeName } from "../../src/internal/protocol/gateway.js"

describe("pinned provider gateway close lifecycle", () => {
    test("keeps established sessions resumable after timeout and rate-limit closes", () => {
        const timeout = classifyClose(4009, true)
        expect(timeout).toMatchObject({
            retry: true,
            resetSession: false,
            failure: { _tag: "ConnectionError", reason: "closed", status: 4009 },
        })
        expect(timeout.failure).toBeInstanceOf(ConnectionError)

        const limited = classifyClose(4008, true)
        expect(limited).toMatchObject({ retry: true, resetSession: false })
        expect(limited.failure).toBeInstanceOf(RateLimitError)
    })

    test("blames the bot's missing heartbeat for 4009, not a missing server acknowledgement", () => {
        // Fluxer closes with 4009 when no heartbeat from the client arrived in time
        expect(closeCodeInfo(4009).meaning).not.toMatch(/acknowledg/i)
    })

    test("names opcode 28 for logs and leaves an unknown opcode unnamed", () => {
        expect(opcodeName(28)).toBe("REQUEST_FORUM_UNREADS")
        expect(opcodeName(99)).toBeNull()
    })

    test("resets only the rejected resume attempt and retains permanent startup failures", () => {
        expect(classifyClose(4007, true)).toMatchObject({ retry: true, resetSession: true })
        expect(classifyClose(4007, false)).toMatchObject({ retry: true, resetSession: false })

        const authentication = classifyClose(4004, true)
        expect(authentication).toMatchObject({ retry: false, resetSession: false })
        expect(authentication.failure).toBeInstanceOf(AuthenticationError)

        for (const code of [4001, 4002, 4003, 4005, 4010, 4011, 4012])
            expect(classifyClose(code, false)).toMatchObject({
                retry: false,
                resetSession: false,
                failure: { _tag: "ConnectionError", reason: "protocol", status: code },
            })
    })

    test("keeps a close reason for logs only, as one bounded line", () => {
        expect(closeReasonText(new TextEncoder().encode("Too many\r\nconnections"))).toBe("Too many connections")
        expect(closeReasonText("\u202e\u0000 ")).toBeUndefined()
        expect(closeReasonText(undefined)).toBeUndefined()
        expect(closeReasonText(`${"é".repeat(200)}`)).toHaveLength(123)
        // The reason never changes how a close code is handled
        expect(classifyClose(4008, true, "any reason")).toMatchObject({ retry: true, closeReason: "any reason" })
    })
})
