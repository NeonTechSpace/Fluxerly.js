import * as Effect from "effect/Effect"
import { expectErr, expectFailure } from "../../support/settle.js"
import { expect, test } from "vitest"
import { supervisor as defaultSupervisor } from "../../../src/index.js"
import { supervisor as nativeSupervisor } from "../../../src/effect.js"
import { ConfigurationError } from "../../../src/errors.js"

const parentOptions = {
    entry: new URL("./workers/supervisor-worker.js", import.meta.url),
    totalShards: 1,
    processes: 1,
    logging: { level: "silent" as const },
}

test.each(["default", "native"] as const)(
    "%s child options reject misspellings before waiting for IPC",
    async (mode) => {
        const options = { token: "fixture-only-not-a-credential", clinetOptions: {}, configure: () => undefined }
        const error =
            mode === "default"
                ? await expectErr(defaultSupervisor.child.run(options))
                : await expectErr(nativeSupervisor.child.run({ ...options, configure: () => Effect.void }))
        expect(error).toBeInstanceOf(ConfigurationError)
        expect(error).toMatchObject({ hint: expect.stringContaining('"clientOptions"') })
    },
)

test("default readiness options reject misspellings before observing an idle supervisor", async () => {
    const supervisor = defaultSupervisor.create(parentOptions)
    const result = await supervisor.waitForReady({ signl: new AbortController().signal } as never)
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({
        _tag: "ConfigurationError",
        hint: expect.stringContaining('"signal"'),
    })
    expect(supervisor.status().state).toBe("idle")
    await supervisor.shutdown()
})

test("default readiness rejects a value that is not a signal before observing the supervisor", async () => {
    // Catches: A malformed signal was used anyway, so the wait threw from inside the SDK or ignored the misuse
    const supervisor = defaultSupervisor.create(parentOptions)
    for (const signal of [{ aborted: false }, "not a signal"]) {
        const result = await supervisor.waitForReady({ signal } as never)
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConfigurationError", field: "signal" })
    }
    expect(supervisor.status().state).toBe("idle")
    await supervisor.shutdown()
})

test.each(["default", "native"] as const)("%s parent option objects suggest corrected keys", async (mode) => {
    for (const [options, expected] of [
        [{ ...parentOptions, startpTimeoutMs: 100 }, "startupTimeoutMs"],
        [{ ...parentOptions, restart: { maxAttemps: 1 } }, "maxAttempts"],
        [{ ...parentOptions, identify: { minimumSpcingMs: 1000 } }, "minimumSpacingMs"],
        [{ ...parentOptions, processes: undefined, assignments: [{ id: "one", shardId: [0] }] }, "shardIds"],
    ] as const) {
        let error: unknown
        if (mode === "default") {
            try {
                defaultSupervisor.create(options as never)
            } catch (caught) {
                error = caught
            }
        } else {
            const cause = await expectFailure(nativeSupervisor.create(options as never))
            expect(cause.reasons).toHaveLength(1)
            const reason = cause.reasons[0]
            expect(reason?._tag).toBe("Die")
            error = reason?._tag === "Die" ? reason.defect : undefined
        }
        expect(error).toBeInstanceOf(ConfigurationError)
        expect(error).toMatchObject({ hint: expect.stringContaining(`"${expected}"`) })
    }
})
