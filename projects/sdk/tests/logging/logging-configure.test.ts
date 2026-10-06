import { Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { ConfigurationError, type LoggingOptions, type LogLevelSettings } from "../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle } from "../support/settle.js"

/** A test client whose configure and message sends run in either API style, counting its Debug REST records */
async function open(mode: Mode, logging?: LoggingOptions) {
    const options = logging === undefined ? {} : { logging }
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return {
            configure: (settings: LogLevelSettings) => test.client.logging.configure(settings),
            send: () => settle(test.client.messages.send(test.fixtures.ids.channel, "hello")),
            requestRecords: () => test.logs().filter((record) => record.code === "rest.request").length,
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return {
        configure: (settings: LogLevelSettings) => test.client.logging.configure(settings),
        send: () => Effect.runPromise(test.client.messages.send(test.fixtures.ids.channel, "hello")),
        requestRecords: () => test.logs().filter((record) => record.code === "rest.request").length,
    }
}

describe.each(modes)("%s client.logging.configure", (mode) => {
    test("changes the log levels for later records, and omitted settings return to their defaults", async () => {
        const driver = await open(mode)
        await driver.send()
        expect(driver.requestRecords()).toBe(0)
        driver.configure({ categories: { rest: "debug" } })
        await driver.send()
        expect(driver.requestRecords()).toBe(1)
        driver.configure({ level: "debug", categories: { rest: "info" } })
        await driver.send()
        expect(driver.requestRecords()).toBe(1)
        driver.configure({})
        await driver.send()
        expect(driver.requestRecords()).toBe(1)
    })

    test("keeps the debug categories chosen at creation", async () => {
        const driver = await open(mode, { debug: ["rest"] })
        driver.configure({ level: "error" })
        await driver.send()
        expect(driver.requestRecords()).toBe(1)
    })

    test("rejects invalid settings with ConfigurationError and keeps the previous levels", async () => {
        const driver = await open(mode)
        driver.configure({ categories: { rest: "debug" } })
        for (const settings of [
            null,
            { level: "loud" },
            { categories: { network: "debug" } },
            { categories: { rest: "debug" }, sink: () => undefined },
        ])
            expect(() => driver.configure(settings as never)).toThrow(ConfigurationError)
        const debug = (() => {
            try {
                driver.configure({ debug: true } as never)
            } catch (error) {
                return error
            }
        })()
        expect(debug).toMatchObject({ hint: expect.stringContaining("Other logging settings are fixed at creation") })
        await driver.send()
        expect(driver.requestRecords()).toBe(1)
    })
})
