import { afterEach, describe, expect, test, vi } from "vitest"
import type { PrefixCommandUnmatched } from "../../../src/index.js"
import { modes } from "../../support/both-apis.js"
import { act, attach, commandFixture, configurationError, connect, createRouter } from "./command-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe.each(modes)("%s hidden command suggestions", (mode) => {
    test("unknown names never suggest hidden commands or anything inside a hidden group, which still run", async () => {
        const remote = await commandFixture()
        const connected = await connect(mode)
        const unmatched: PrefixCommandUnmatched[] = []
        const executed: string[] = []
        const execute = ({ name }: { name: string }) => act(mode, () => void executed.push(name))
        const router = createRouter(mode, {
            prefix: "!",
            onUnmatched: (_context: unknown, outcome: PrefixCommandUnmatched) =>
                act(mode, () => void unmatched.push(outcome)),
        })
            .registerMany({ ping: { execute }, shutdown: { hidden: true, execute } })
            .registerGroup({ name: "secret", hidden: true })
            .register({ name: "inspect", execute }, { group: ["secret"] })
        await attach(connected, router, { concurrency: 1 })

        for (const content of ["!png", "!shutdwn", "!secrt", "!secret inspcet", "!shutdown", "!secret inspect"])
            remote.deliver(content)
        await vi.waitFor(() => expect(executed).toHaveLength(2))
        await vi.waitFor(() => expect(unmatched).toHaveLength(4))

        expect(unmatched).toEqual([
            { _tag: "CommandUnknownName", name: "png", suggestion: "ping" },
            { _tag: "CommandUnknownName", name: "shutdwn" },
            { _tag: "CommandUnknownName", name: "secrt" },
            { _tag: "CommandUnknownName", name: "inspcet", path: ["secret"] },
        ])
        expect(executed).toEqual(["shutdown", "inspect"])
        const records = connected.logs.withCode("commands.unmatched")
        expect(records.map((record) => record.fields?.suggestion)).toEqual(["ping", undefined, undefined, undefined])
    })

    test("hidden must be a boolean on commands and groups", () => {
        const router = createRouter(mode, { prefix: "!" })
        const execute = () => act(mode, () => undefined)
        expect(configurationError(() => router.register({ name: "ping", hidden: "yes", execute })).field).toBe(
            "command",
        )
        expect(configurationError(() => router.registerGroup({ name: "admin", hidden: 1 } as never)).field).toBe(
            "command",
        )
    })
})
