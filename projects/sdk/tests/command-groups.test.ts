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

test("default batch registration uses own-key order and fails atomically on invalid entries or collisions", () => {
    const root = commands.create({ prefix: "!" })._unsafeUnwrap()
    const inherited = {
        inherited: { arguments: {}, execute() {} },
    }
    const definitions = Object.assign(Object.create(inherited), {
        10: { arguments: {}, execute() {} },
        2: { arguments: {}, execute() {} },
        alpha: { arguments: undefined, execute() {} },
    })
    const ordered = root.registerMany(definitions)._unsafeUnwrap()
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])
    expect(root.commands).toEqual([])

    const duplicate = ordered.registerMany({
        first: { arguments: {}, aliases: ["shared"], execute() {} },
        second: { arguments: {}, aliases: ["shared"], execute() {} },
    })
    expect(duplicate.isErr()).toBe(true)
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])

    const unknown = ordered.registerMany({
        valid: { arguments: {}, execute() {} },
        invalid: { arguments: {}, execute() {}, privateOption: true },
    } as never)
    expect(unknown.isErr()).toBe(true)
    expect(ordered.commands.map((entry) => entry.name)).toEqual(["2", "10", "alpha"])
    expect(ordered.registerMany({ alpha: { arguments: {}, execute() {} } }).isErr()).toBe(true)
    expect(ordered.registerMany({ embedded: { name: "other", arguments: {}, execute() {} } } as never).isErr()).toBe(
        true,
    )
    expect(ordered.registerMany({} as never).isErr()).toBe(true)
    expect(
        ordered
            .registerMany({
                [Symbol("private")]: { arguments: {}, execute() {} },
                valid: { arguments: {}, execute() {} },
            } as never)
            .isErr(),
    ).toBe(true)

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

test("native batch registration is lazy and fails atomically without admitting inherited entries", async () => {
    const root = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    const inherited = {
        inherited: { arguments: {}, execute: () => Effect.void },
    }
    const definitions = Object.assign(Object.create(inherited), {
        first: { arguments: {}, aliases: ["one"], execute: () => Effect.void },
        second: { arguments: undefined, execute: () => Effect.void },
    })
    const operation = root.registerMany(definitions)
    expect(root.commands).toEqual([])
    const registered = await Effect.runPromise(operation)
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])

    const duplicate = registered.registerMany({
        third: { arguments: {}, aliases: ["shared"], execute: () => Effect.void },
        fourth: { arguments: {}, aliases: ["shared"], execute: () => Effect.void },
    })
    const duplicateExit = await Effect.runPromiseExit(duplicate)
    expect(Exit.isFailure(duplicateExit) && Cause.hasFails(duplicateExit.cause)).toBe(true)
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])
    const symbolExit = await Effect.runPromiseExit(
        registered.registerMany({
            [Symbol("private")]: { arguments: {}, execute: () => Effect.void },
            valid: { arguments: {}, execute: () => Effect.void },
        } as never),
    )
    expect(Exit.isFailure(symbolExit) && Cause.hasFails(symbolExit.cause)).toBe(true)
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])

    let reads = 0
    const accessor = Object.defineProperty({}, "private", {
        enumerable: true,
        get() {
            reads += 1
            throw new Error("native private accessor")
        },
    })
    const accessorOperation = registered.registerMany(accessor as never)
    expect(reads).toBe(0)
    const accessorExit = await Effect.runPromiseExit(accessorOperation)
    expect(reads).toBe(1)
    expect(Exit.isFailure(accessorExit) && Cause.hasDies(accessorExit.cause)).toBe(true)
    expect(registered.commands.map((entry) => entry.name)).toEqual(["first", "second"])
})

test("default batch registration snapshots one parent before adding any command", () => {
    const root = commands
        .create({ prefix: "!" })
        ._unsafeUnwrap()
        .registerGroup({ name: "a" })
        ._unsafeUnwrap()
        .registerGroup({ name: "b" })
        ._unsafeUnwrap()
    let reads = 0
    const options = Object.defineProperty({}, "group", {
        enumerable: true,
        get() {
            reads += 1
            return reads <= 2 ? ["a"] : ["b"]
        },
    })
    const registered = root
        .registerMany(
            {
                first: { arguments: {}, execute() {} },
                second: { arguments: {}, execute() {} },
            },
            options,
        )
        ._unsafeUnwrap()

    expect(reads).toBe(1)
    expect(registered.commands.map((entry) => entry.path)).toEqual([
        ["a", "first"],
        ["a", "second"],
    ])
    expect(root.commands).toEqual([])
})

test("native batch registration lazily snapshots one parent before adding any command", async () => {
    const created = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    const a = await Effect.runPromise(created.registerGroup({ name: "a" }))
    const root = await Effect.runPromise(a.registerGroup({ name: "b" }))
    let reads = 0
    const options = Object.defineProperty({}, "group", {
        enumerable: true,
        get() {
            reads += 1
            return reads <= 2 ? ["a"] : ["b"]
        },
    })
    const operation = root.registerMany(
        {
            first: { arguments: {}, execute: () => Effect.void },
            second: { arguments: {}, execute: () => Effect.void },
        },
        options,
    )
    expect(reads).toBe(0)
    const registered = await Effect.runPromise(operation)

    expect(reads).toBe(1)
    expect(registered.commands.map((entry) => entry.path)).toEqual([
        ["a", "first"],
        ["a", "second"],
    ])
    expect(root.commands).toEqual([])
})
