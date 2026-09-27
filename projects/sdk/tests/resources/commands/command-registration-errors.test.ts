import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ApplicationError, ConfigurationError, runBot } from "../../../src/index.js"
import { runBot as runNativeBot } from "../../../src/effect.js"
import { fixtureToken, modes, type Mode } from "../../support/both-apis.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** How runBot stopped before any client existed */
interface Stopped {
    /** A synchronous throw or native defect for misuse, or a returned Err or native failure for an application outcome */
    readonly as: "thrown" | "defect" | "failure"
    readonly error: unknown
}

/**
 * Run a bot whose commands option uses a register callback, returning what stopped it before any client existed:
 * a synchronous throw or Err from the default runBot, or a defect or failure of the native runBot
 */
async function registrationOutcome(
    mode: Mode,
    register: (router: never) => unknown,
    signal?: AbortSignal,
): Promise<Stopped> {
    // No request may start: a registration failure stops the bot before a client exists
    const fetch = vi.fn(() => Promise.reject(new Error("No request is expected")))
    vi.stubGlobal("fetch", fetch)
    const options = {
        token: fixtureToken,
        commands: { prefix: "!", commands: register as never },
        ...(signal === undefined ? {} : { signal }),
    }
    let stopped: Stopped
    if (mode === "default") {
        let result: Awaited<ReturnType<typeof runBot>> | undefined
        try {
            result = await runBot(options)
        } catch (error) {
            stopped = { as: "thrown", error }
        }
        if (result !== undefined) {
            expect(result.isErr()).toBe(true)
            stopped = { as: "failure", error: result.isErr() ? result.error : undefined }
        }
    } else {
        const exit = await Effect.runPromiseExit(runNativeBot(options) as Effect.Effect<unknown, unknown>)
        expect(Exit.isFailure(exit)).toBe(true)
        const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
        expect(reasons).toHaveLength(1)
        const reason = reasons[0]!
        stopped = Cause.isDieReason(reason)
            ? { as: "defect", error: reason.defect }
            : { as: "failure", error: Cause.isFailReason(reason) ? reason.error : reason }
    }
    expect(fetch).not.toHaveBeenCalled()
    return stopped!
}

describe.each(modes)("%s runBot commands register callback", (mode) => {
    test("an application error thrown by the callback is returned as ApplicationError carrying it", async () => {
        const failure = new Error("commands could not be loaded")
        const stopped = await registrationOutcome(mode, () => {
            throw failure
        })
        expect(stopped.as).toBe("failure")
        expect(stopped.error).toBeInstanceOf(ApplicationError)
        expect(stopped.error).toMatchObject({ source: "runBot commands", cause: failure })
    })

    test("the callback's failure is returned even when the signal is already aborted", async () => {
        const failure = new Error("commands could not be loaded")
        const stopped = await registrationOutcome(
            mode,
            () => {
                throw failure
            },
            AbortSignal.abort(),
        )
        expect(stopped.error).toMatchObject({ source: "runBot commands", cause: failure })
    })

    test("misuse inside the callback keeps its ConfigurationError", async () => {
        const stopped = await registrationOutcome(mode, (router: { register(command: object): unknown }) =>
            router.register({ name: "bad name", execute: () => undefined }),
        )
        expect(stopped.as).toBe(mode === "default" ? "thrown" : "defect")
        expect(stopped.error).toBeInstanceOf(ConfigurationError)
    })

    test("an application ConfigurationError thrown by the callback is kept as misuse", async () => {
        const misuse = new ConfigurationError("commands", "Application-defined misuse")
        const stopped = await registrationOutcome(mode, () => {
            throw misuse
        })
        expect(stopped).toEqual({ as: mode === "default" ? "thrown" : "defect", error: misuse })
    })
})
