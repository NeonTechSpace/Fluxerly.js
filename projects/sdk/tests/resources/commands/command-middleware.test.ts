import { setImmediate as turn } from "node:timers/promises"
import { Effect, Scope } from "effect"
import { err } from "neverthrow"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { commands, type Subscription } from "../../../src/index.js"
import { commands as nativeCommands, type Subscription as NativeSubscription } from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { act, attach, commandFixture, configurationError, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** Middleware that records around the rest of the command, continuing the given number of times */
function recording(mode: Mode, name: string, log: string[], continues = 1) {
    if (mode === "default")
        return async (_context: unknown, next: () => Promise<void>) => {
            log.push(`${name}:before`)
            for (let index = 0; index < continues; index += 1) await next()
            log.push(`${name}:after`)
        }
    return (_context: unknown, next: Effect.Effect<void, unknown>) =>
        Effect.sync(() => log.push(`${name}:before`)).pipe(
            Effect.andThen(Effect.forEach(Array.from({ length: continues }), () => next)),
            Effect.andThen(Effect.sync(() => log.push(`${name}:after`))),
        )
}

describe.each(modes)("%s command middleware", (mode) => {
    test("runs in order around the guard and command, which run once even when next is called twice", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const log: string[] = []
        const router = createRouter(mode, {
            prefix: "!",
            // The last middleware continues twice, and the rest of the command still runs once
            use: [recording(mode, "outer", log), recording(mode, "inner", log, 2)],
        }).register({
            name: "ping",
            guard: ({ name }: { name: string }) => act(mode, () => log.push(`guard:${name}`) > 0),
            execute: () => act(mode, () => void log.push("execute")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(log).toContain("outer:after"))
        expect(log).toEqual(["outer:before", "inner:before", "guard:ping", "execute", "inner:after", "outer:after"])
        expect(reports).toEqual([])
    })

    test("middleware that does not continue stops the command with a Debug record", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const log: string[] = []
        const router = createRouter(mode, {
            prefix: "!",
            use: [
                ({ name }: { name: string }) =>
                    act(mode, () => {
                        log.push(`stopped:${name}`)
                    }),
            ],
        }).register({
            name: "ping",
            guard: () => act(mode, () => log.push("guard") > 0),
            execute: () => act(mode, () => void log.push("execute")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(connected.logs.withCode("commands.middlewareStopped")).toHaveLength(1))
        expect(connected.logs.withCode("commands.middlewareStopped")[0]).toMatchObject({
            level: "debug",
            category: "commands",
            command: "ping",
        })
        expect(log).toEqual(["stopped:ping"])
        expect(reports).toEqual([])
        expect(connected.logs.withCode("commands.executed")).toEqual([])
    })

    test("a command failure is reported with the command name even when middleware recovers from it", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("command failed")
        const recovered: string[] = []
        const recover =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await next().catch(() => void recovered.push("caught"))
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      next.pipe(Effect.catchCause(() => Effect.sync(() => void recovered.push("caught"))))
        const router = createRouter(mode, { prefix: "!", use: [recover] }).register({
            name: "ping",
            execute: () => (mode === "default" ? Promise.reject(failure) : Effect.fail(failure)),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(recovered).toEqual(["caught"])
        expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
    })

    test("a failing middleware is reported with the command name and the command does not run", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("middleware failed")
        const executed: string[] = []
        const failing =
            mode === "default"
                ? () => {
                      throw failure
                  }
                : () => Effect.fail(failure)
        const router = createRouter(mode, { prefix: "!", use: [failing] }).register({
            name: "ping",
            execute: () => act(mode, () => void executed.push("ping")),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
        expect(executed).toEqual([])
    })

    test("next fails with the command's own error, so middleware can inspect it", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("command failed")
        const seen: unknown[] = []
        const inspect =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await next().catch((error: unknown) => void seen.push(error))
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      next.pipe(Effect.catch((error) => Effect.sync(() => void seen.push(error))))
        const router = createRouter(mode, { prefix: "!", use: [inspect] }).register({
            name: "ping",
            execute: () => (mode === "default" ? Promise.reject(failure) : Effect.fail(failure)),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(seen).toEqual([failure])
        expect(seen[0]).toBe(failure)
    })

    test("middleware that rethrows the command's error reports it once", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("command failed")
        const rethrow =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await next().catch((error: unknown) => {
                          throw error
                      })
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      next.pipe(Effect.catch((error) => Effect.fail(error)))
        const router = createRouter(mode, { prefix: "!", use: [rethrow] }).register({
            name: "ping",
            execute: () => (mode === "default" ? Promise.reject(failure) : Effect.fail(failure)),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0))
        // The second delivery's report proves the first had no further report queued after it
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports.length).toBeGreaterThan(1))
        expect(reports.map((report) => report.error)).toEqual([failure, failure])
        expect(reports.map((report) => report.message?.id)).toEqual(["101", "102"])
    })

    test("middleware that replaces the command's failure reports the command's failure, then its own", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("command failed")
        const replacement = new Error("middleware replaced it")
        const replace =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await next().catch(() => {
                          throw replacement
                      })
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      next.pipe(Effect.catch(() => Effect.fail(replacement)))
        const router = createRouter(mode, { prefix: "!", use: [replace] }).register({
            name: "ping",
            execute: () => (mode === "default" ? Promise.reject(failure) : Effect.fail(failure)),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(reports).toHaveLength(2))
        expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
        expect(reports[1]).toMatchObject({ kind: "handler", command: "ping", error: replacement })
        expect(reports[0]!.message).toEqual(reports[1]!.message)
    })

    test("a command failure is still reported when the subscription closes while middleware is running", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const failure = new Error("command failed")
        let caught = false
        const hold =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await next().catch(() => {
                          caught = true
                      })
                      await new Promise(() => undefined)
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      next.pipe(
                          Effect.catch(() =>
                              Effect.sync(() => {
                                  caught = true
                              }),
                          ),
                          Effect.andThen(Effect.never),
                      )
        const router = createRouter(mode, { prefix: "!", use: [hold] }).register({
            name: "ping",
            execute: () => (mode === "default" ? Promise.reject(failure) : Effect.fail(failure)),
        })
        const subscription =
            connected.mode === "default"
                ? (router as unknown as ReturnType<typeof commands.create>).attach(connected.client)
                : await Effect.runPromise(
                      (router as unknown as ReturnType<typeof nativeCommands.create>)
                          .attach(connected.client)
                          .pipe(Scope.provide(connected.registration)) as Effect.Effect<NativeSubscription>,
                  )
        remote.deliver("!ping")
        await vi.waitFor(() => expect(caught).toBe(true))
        expect(connected.logs.withCode("commands.failed")).toEqual([])
        await (connected.mode === "default"
            ? (subscription as Subscription).close()
            : Effect.runPromise((subscription as NativeSubscription).close()))
        await vi.waitFor(() => expect(connected.logs.withCode("commands.failed")).toHaveLength(1))
        expect(connected.logs.withCode("commands.failed")[0]).toMatchObject({
            command: "ping",
            error: { message: failure.message },
        })
    })

    test("calling next twice runs later middleware and the command once", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const log: string[] = []
        const router = createRouter(mode, {
            prefix: "!",
            use: [recording(mode, "outer", log, 2), recording(mode, "inner", log)],
        }).register({ name: "ping", execute: () => act(mode, () => void log.push("execute")) })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(log).toContain("outer:after"))
        expect(log).toEqual(["outer:before", "inner:before", "execute", "inner:after", "outer:after"])
        expect(reports).toEqual([])
    })

    test("concurrent next calls run later middleware and the command once", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const log: string[] = []
        const concurrent =
            mode === "default"
                ? async (_context: unknown, next: () => Promise<void>) => {
                      await Promise.all([next(), next()])
                      log.push("outer:after")
                  }
                : (_context: unknown, next: Effect.Effect<void, unknown>) =>
                      Effect.all([next, next], { concurrency: 2 }).pipe(
                          Effect.andThen(Effect.sync(() => log.push("outer:after"))),
                      )
        const router = createRouter(mode, {
            prefix: "!",
            use: [concurrent, recording(mode, "inner", log)],
        }).register({
            name: "ping",
            // The command yields before finishing, so a second concurrent run would start before the first completes
            execute: () => act(mode, () => turn()),
        })
        const reports = await attach(connected, router)
        remote.deliver("!ping")
        await vi.waitFor(() => expect(log).toContain("outer:after"))
        expect(log).toEqual(["inner:before", "inner:after", "outer:after"])
        expect(connected.logs.withCode("commands.executed")).toHaveLength(1)
        expect(reports).toEqual([])
    })

    test("middleware lists are validated when the router is created", () => {
        for (const use of [() => undefined, [1], [undefined], "middleware"])
            expect(configurationError(() => createRouter(mode, { prefix: "!", use })).field).toBe("commands")
    })
})

test("default middleware that does not await next still has the command's failure reported, without an unhandled rejection", async () => {
    const remote = await commandFixture()
    const connected = await connect("default")
    const failure = new Error("command failed")
    const unhandled: unknown[] = []
    const record = (reason: unknown) => void unhandled.push(reason)
    process.on("unhandledRejection", record)
    onTestFinished(() => void process.off("unhandledRejection", record))
    const router = createRouter("default", {
        prefix: "!",
        use: [(_context: unknown, next: () => Promise<void>) => void next()],
    }).register({ name: "ping", execute: () => Promise.reject(failure) })
    const reports = await attach(connected, router)
    remote.deliver("!ping")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
    // Node reports an unhandled rejection once the microtask queue drains, so two event-loop turns are enough
    await turn()
    await turn()
    expect(unhandled).toEqual([])
})

test("default middleware returning an Err result is reported like a thrown error", async () => {
    const remote = await commandFixture()
    const connected = await connect("default")
    const failure = new Error("middleware result")
    const executed: string[] = []
    const router = createRouter("default", { prefix: "!", use: [async () => err(failure)] }).register({
        name: "ping",
        execute: () => void executed.push("ping"),
    })
    const reports = await attach(connected, router)
    remote.deliver("!ping")
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ kind: "handler", command: "ping", error: failure })
    expect(executed).toEqual([])
})
