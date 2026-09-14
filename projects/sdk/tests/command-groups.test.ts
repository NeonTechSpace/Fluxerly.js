import { Cause, Effect, Exit } from "effect"
import { expect, test } from "vitest"
import { commands, SdkDefect } from "../src/index.js"
import { commands as nativeCommands } from "../src/effect.js"

test("group registrations copy identities and canonical parent paths without changing earlier metadata", () => {
    const root = commands.create({ prefix: "!" })._unsafeUnwrap()
    const aliases = ["a"]
    const definition = { name: "Admin", aliases, description: "Administration" }
    const grouped = root.registerGroup(definition)._unsafeUnwrap()
    definition.name = "changed"
    definition.description = "changed"
    aliases.push("changed")
    const parent = ["Admin"]
    const nested = grouped.registerGroup({ name: "users", aliases: ["u"] }, { group: parent })._unsafeUnwrap()
    const extended = nested.register({ name: "inspect", execute() {} }, { group: ["Admin", "users"] })._unsafeUnwrap()
    parent[0] = "changed"

    expect(root.groups).toEqual([])
    expect(root.commands).toEqual([])
    expect(grouped.groups).toEqual([
        { name: "Admin", aliases: ["a"], description: "Administration", kind: "group", path: ["Admin"] },
    ])
    expect(grouped.commands).toEqual([])
    expect(extended.commands).toEqual([{ name: "inspect", path: ["Admin", "users", "inspect"] }])
    expect(extended.groups).toHaveLength(2)
    expect(Object.isFrozen(extended.groups)).toBe(true)
    expect(Object.isFrozen(extended.groups[0])).toBe(true)
    expect(Object.isFrozen(extended.groups[0]!.path)).toBe(true)
    expect(Object.isFrozen(extended.groups[0]!.aliases)).toBe(true)
    expect(Object.isFrozen(extended.commands[0]!.path)).toBe(true)
    expect(grouped.register({ name: "inspect", execute() {} }, { group: ["a"] }).isErr()).toBe(true)
    expect(grouped.registerGroup({ name: "child" }, { group: ["admin"] }).isErr()).toBe(true)
})

test("command and group aliases collide only among siblings under the router matching policy", () => {
    let router = commands.create({ prefix: "!" })._unsafeUnwrap()
    router = router.registerGroup({ name: "admin", aliases: ["a"] })._unsafeUnwrap()
    router = router.registerGroup({ name: "users" })._unsafeUnwrap()
    router = router.register({ name: "inspect", aliases: ["i"], execute() {} }, { group: ["admin"] })._unsafeUnwrap()
    expect(router.registerGroup({ name: "A" }).isErr()).toBe(true)
    expect(router.register({ name: "a", execute() {} }).isErr()).toBe(true)
    expect(router.registerGroup({ name: "I" }, { group: ["admin"] }).isErr()).toBe(true)
    expect(router.registerGroup({ name: "inspect", aliases: ["INSPECT"] }, { group: ["users"] }).isErr()).toBe(true)
    expect(router.register({ name: "inspect", aliases: ["i"], execute() {} }, { group: ["users"] }).isOk()).toBe(true)
    const exact = commands
        .create({ prefix: "!", caseSensitive: true })
        ._unsafeUnwrap()
        .registerGroup({ name: "Admin", aliases: ["admin"] })
        ._unsafeUnwrap()
        .register({ name: "Inspect", execute() {} }, { group: ["Admin"] })
        ._unsafeUnwrap()
        .register({ name: "inspect", execute() {} }, { group: ["Admin"] })
        ._unsafeUnwrap()
    expect(exact.commands.map((entry) => entry.name)).toEqual(["Inspect", "inspect"])
    expect(exact.registerGroup({ name: "admin" }).isErr()).toBe(true)
})

test("group configuration rejects policy fields and malformed targets without reporting caller values", async () => {
    const root = commands.create({ prefix: "!" })._unsafeUnwrap()
    const grouped = root.registerGroup({ name: "admin" })._unsafeUnwrap()
    const invalid = [
        root.registerGroup({ name: "bad name" }),
        root.registerGroup({ name: "private", execute() {} } as never),
        root.registerGroup({ name: "private", guard: () => true } as never),
        root.registerGroup({ name: "private", arguments: {} } as never),
        root.registerGroup({ name: "private", cooldown: {} } as never),
        grouped.registerGroup({ name: "child" }, { group: ["missing-private"] }),
        grouped.registerGroup({ name: "child" }, { group: new Array(1) }),
        grouped.register({ name: "leaf", execute() {} }, { group: "private" } as never),
        grouped.register({ name: "leaf", execute() {} }, { otherPrivate: true } as never),
    ]
    for (const result of invalid) {
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.message).not.toContain("private")
    }
    expect(() =>
        root.registerGroup({
            get name(): string {
                throw new Error("private")
            },
        }),
    ).toThrow(SdkDefect)
    const native = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    const operation = native.registerGroup({
        get name(): string {
            throw new Error("native-private")
        },
    })
    const exit = await Effect.runPromiseExit(operation)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
})

test("native group registration remains lazy and preserves earlier snapshots", async () => {
    let nameReads = 0
    const root = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    const operation = root.registerGroup({
        get name() {
            nameReads += 1
            return "admin"
        },
    })
    expect(nameReads).toBe(0)
    const grouped = await Effect.runPromise(operation)
    expect(nameReads).toBe(1)
    const nested = await Effect.runPromise(grouped.registerGroup({ name: "users" }, { group: ["admin"] }))
    expect(root.groups).toEqual([])
    expect(grouped.groups).toHaveLength(1)
    expect(nested.groups).toHaveLength(2)
})
