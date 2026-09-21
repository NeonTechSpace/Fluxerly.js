import { describe, expect, test } from "vitest"
import { AuthenticationError, ConnectionError, RateLimitError } from "../src/errors.js"
import { classifyClose } from "../src/internal/gateway.js"

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
})
