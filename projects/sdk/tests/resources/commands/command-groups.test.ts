import { Effect } from "effect"
import { expect, test } from "vitest"
import { commands, SdkDefect } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { configurationError } from "./command-fixture.js"

test("group registrations copy identities and canonical parent paths without changing earlier metadata", () => {
    const root = commands.create({ prefix: "!" })
    const aliases = ["a"]
    const definition = { name: "Admin", aliases, description: "Administration" }
    const grouped = root.registerGroup(definition)
    definition.name = "changed"
    definition.description = "changed"
    aliases.push("changed")
    const parent = ["Admin"]
    const nested = grouped.registerGroup({ name: "users", aliases: ["u"] }, { group: parent })
    const extended = nested.register({ name: "inspect", execute() {} }, { group: ["Admin", "users"] })
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
    configurationError(() => grouped.register({ name: "inspect", execute() {} }, { group: ["a"] }))
    configurationError(() => grouped.registerGroup({ name: "child" }, { group: ["admin"] }))
})

test("command and group aliases collide only among siblings under the router matching policy", () => {
    let router = commands.create({ prefix: "!" })
    router = router.registerGroup({ name: "admin", aliases: ["a"] })
    router = router.registerGroup({ name: "users" })
    router = router.register({ name: "inspect", aliases: ["i"], execute() {} }, { group: ["admin"] })
    configurationError(() => router.registerGroup({ name: "A" }))
    configurationError(() => router.register({ name: "a", execute() {} }))
    configurationError(() => router.registerGroup({ name: "I" }, { group: ["admin"] }))
    configurationError(() => router.registerGroup({ name: "inspect", aliases: ["INSPECT"] }, { group: ["users"] }))
    expect(
        router.register({ name: "inspect", aliases: ["i"], execute() {} }, { group: ["users"] }).commands,
    ).toHaveLength(2)
    const exact = commands
        .create({ prefix: "!", caseSensitive: true })
        .registerGroup({ name: "Admin", aliases: ["admin"] })
        .register({ name: "Inspect", execute() {} }, { group: ["Admin"] })
        .register({ name: "inspect", execute() {} }, { group: ["Admin"] })
    expect(exact.commands.map((entry) => entry.name)).toEqual(["Inspect", "inspect"])
    configurationError(() => exact.registerGroup({ name: "admin" }))
})

test("group configuration rejects policy fields and malformed targets without reporting caller values", () => {
    const root = commands.create({ prefix: "!" })
    const grouped = root.registerGroup({ name: "admin" })
    const invalid = [
        () => root.registerGroup({ name: "bad name" }),
        () => root.registerGroup({ name: "private", execute() {} } as never),
        () => root.registerGroup({ name: "private", guard: () => true } as never),
        () => root.registerGroup({ name: "private", arguments: {} } as never),
        () => root.registerGroup({ name: "private", cooldown: {} } as never),
        () => grouped.registerGroup({ name: "child" }, { group: ["missing-private"] }),
        () => grouped.registerGroup({ name: "child" }, { group: new Array(1) }),
        () => grouped.register({ name: "leaf", execute() {} }, { group: "private" } as never),
        () => grouped.register({ name: "leaf", execute() {} }, { otherPrivate: true } as never),
    ]
    for (const run of invalid) expect(configurationError(run).message).not.toContain("private")
    expect(() =>
        root.registerGroup({
            get name(): string {
                throw new Error("private")
            },
        }),
    ).toThrow(SdkDefect)
    const native = nativeCommands.create({ prefix: "!" })
    expect(() =>
        native.registerGroup({
            get name(): string {
                throw new Error("native-private")
            },
        }),
    ).toThrow(SdkDefect)
    for (const run of [
        () => native.registerGroup({ name: "bad name" }),
        () => native.registerGroup({ name: "child" }, { group: ["missing-private"] }),
    ])
        expect(configurationError(run).message).not.toContain("private")
})

test("native group registration reads its definition once at registration and preserves earlier snapshots", () => {
    let nameReads = 0
    const root = nativeCommands.create({ prefix: "!" })
    const grouped = root.registerGroup({
        get name() {
            nameReads += 1
            return "admin"
        },
    })
    expect(nameReads).toBe(1)
    const nested = grouped.registerGroup({ name: "users" }, { group: ["admin"] })
    expect(nameReads).toBe(1)
    expect(root.groups).toEqual([])
    expect(grouped.groups).toHaveLength(1)
    expect(nested.groups).toHaveLength(2)
})

test("default batch registration uses own-key order and fails atomically on invalid entries or collisions", () => {
    const root = commands.create({ prefix: "!" })
    const inherited = {
        inherited: { arguments: {}, execute() {} },
    }
    const definitions = Object.assign(Object.create(inherited), {
        10: { arguments: {}, execute() {} },
        2: { arguments: {}, execute() {} },
        alpha: { execute() {} },
    })
    const ordered = root.registerMany(definitions)
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])
    expect(root.commands).toEqual([])

    configurationError(() =>
        ordered.registerMany({
            first: { arguments: {}, aliases: ["shared"], execute() {} },
            second: { arguments: {}, aliases: ["shared"], execute() {} },
        }),
    )
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])

    configurationError(() =>
        ordered.registerMany({
            valid: { arguments: {}, execute() {} },
            invalid: { arguments: {}, execute() {}, privateOption: true },
        } as never),
    )
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])
    configurationError(() => ordered.registerMany({ alpha: { arguments: {}, execute() {} } }))
    configurationError(() =>
        ordered.registerMany({ embedded: { name: "other", arguments: {}, execute() {} } } as never),
    )
    configurationError(() => ordered.registerMany({} as never))
    configurationError(() =>
        ordered.registerMany({
            [Symbol("private")]: { arguments: {}, execute() {} },
            valid: { arguments: {}, execute() {} },
        } as never),
    )

    const accessed: string[] = []
    const accessorBatch = Object.defineProperty({}, "private", {
        enumerable: true,
        get() {
            accessed.push("read")
            throw new Error("private accessor value")
        },
    })
    expect(() => ordered.registerMany(accessorBatch as never)).toThrow(SdkDefect)
    expect(accessed).toEqual(["read"])
})

test("native batch registration fails atomically without admitting inherited entries", () => {
    const root = nativeCommands.create({ prefix: "!" })
    const inherited = {
        inherited: { arguments: {}, execute: () => Effect.void },
    }
    const definitions = Object.assign(Object.create(inherited), {
        first: { arguments: {}, aliases: ["one"], execute: () => Effect.void },
        second: { execute: () => Effect.void },
    })
    const registered = root.registerMany(definitions)
    expect(root.commands).toEqual([])
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])

    configurationError(() =>
        registered.registerMany({
            third: { arguments: {}, aliases: ["shared"], execute: () => Effect.void },
            fourth: { arguments: {}, aliases: ["shared"], execute: () => Effect.void },
        }),
    )
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])
    configurationError(() =>
        registered.registerMany({
            [Symbol("private")]: { arguments: {}, execute: () => Effect.void },
            valid: { arguments: {}, execute: () => Effect.void },
        } as never),
    )
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])

    let reads = 0
    const accessor = Object.defineProperty({}, "private", {
        enumerable: true,
        get() {
            reads += 1
            throw new Error("native private accessor")
        },
    })
    expect(() => registered.registerMany(accessor as never)).toThrow(SdkDefect)
    expect(reads).toBe(1)
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])
})

test("default batch registration snapshots one parent before adding any command", () => {
    const root = commands.create({ prefix: "!" }).registerGroup({ name: "a" }).registerGroup({ name: "b" })
    let reads = 0
    const options = Object.defineProperty({}, "group", {
        enumerable: true,
        get() {
            reads += 1
            return reads <= 2 ? ["a"] : ["b"]
        },
    })
    const registered = root.registerMany(
        {
            first: { arguments: {}, execute() {} },
            second: { arguments: {}, execute() {} },
        },
        options,
    )

    expect(reads).toBe(1)
    expect(registered.commands.map((entry) => entry.path)).toEqual([
        ["a", "first"],
        ["a", "second"],
    ])
    expect(root.commands).toEqual([])
})

test("native batch registration snapshots one parent before adding any command", () => {
    const root = nativeCommands.create({ prefix: "!" }).registerGroup({ name: "a" }).registerGroup({ name: "b" })
    let reads = 0
    const options = Object.defineProperty({}, "group", {
        enumerable: true,
        get() {
            reads += 1
            return reads <= 2 ? ["a"] : ["b"]
        },
    })
    const registered = root.registerMany(
        {
            first: { arguments: {}, execute: () => Effect.void },
            second: { arguments: {}, execute: () => Effect.void },
        },
        options,
    )

    expect(reads).toBe(1)
    expect(registered.commands.map((entry) => entry.path)).toEqual([
        ["a", "first"],
        ["a", "second"],
    ])
    expect(root.commands).toEqual([])
})
