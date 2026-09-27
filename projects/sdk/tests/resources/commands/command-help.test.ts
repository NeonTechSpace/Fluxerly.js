import { Effect } from "effect"
import { expect, test } from "vitest"
import { commands } from "../../../src/index.js"
import { commands as nativeCommands } from "../../../src/effect.js"
import { configurationError as helpError } from "./command-fixture.js"

/** One help entry: the invocation it starts with, whether it is marked as a group, and its remaining text */
interface HelpEntry {
    readonly invocation: string
    readonly group: boolean
    /** Group marker, aliases and description after the invocation, in the renderer's layout */
    readonly details: string
}

/**
 * Split help pages into entries, each starting at a line that begins with the display prefix.
 * The router documents what an entry shows (the full path with its argument syntax, aliases, the description and a
 * (Group) marker) but not the layout between those parts, so tests compare entries instead of whole pages
 */
function helpEntries(pages: readonly string[], prefix: string): HelpEntry[] {
    const texts: string[] = []
    for (const line of pages.join("\n").split("\n"))
        if (line.startsWith(prefix)) texts.push(line)
        else if (texts.length > 0 && line.trim() !== "") texts[texts.length - 1] += `\n${line}`
    return texts.map((text) => {
        const [head = "", ...rest] = text.split("\n")
        // Markers such as (Group) and the alias list follow the invocation in parentheses
        const invocation = head.replace(/(\s+\([^)]*\))+$/, "")
        const details = [head.slice(invocation.length).trim(), ...rest].filter((part) => part !== "").join("\n")
        return { invocation, group: details.includes("(Group)"), details }
    })
}

/** Match entry details that mention every part, in any order or layout */
function mentions(...parts: string[]) {
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return expect.stringMatching(new RegExp(parts.map((part) => `(?=[\\s\\S]*${escape(part)})`).join("")))
}

test("default help lists entries in registration order with generated signatures, explicit usage, aliases and descriptions", () => {
    let router = commands.create({ prefix: "unused" })
    router = router.register({
        name: "deploy",
        aliases: ["d", "ship"],
        description: "Deploys the selected service",
        arguments: {
            service: { type: "text" },
            version: { type: "integer", optional: true },
            note: { type: "text", rest: true, optional: true },
        } as const,
        execute: () => undefined,
    })
    router = router.register({
        name: "status",
        usage: "",
        description: "",
        arguments: { target: { type: "text" } } as const,
        execute: () => undefined,
    })
    router = router.register({
        name: "restart",
        usage: "service --force",
        arguments: { ignored: { type: "text" } } as const,
        execute: () => undefined,
    })

    expect(helpEntries(router.help({ prefix: "!", maxLength: 1_000 }), "!")).toEqual([
        {
            invocation: "!deploy <service> [version] [note...]",
            group: false,
            details: mentions("!d", "!ship", "Deploys the selected service"),
        },
        // An explicit empty usage suppresses the inferred syntax, and an empty description adds nothing
        { invocation: "!status", group: false, details: "" },
        // Explicit usage replaces the syntax inferred from arguments
        { invocation: "!restart service --force", group: false, details: "" },
    ])
})

test("default help filters frozen metadata once without running command callbacks or prefix resolution", () => {
    let prefixCalls = 0
    let guardCalls = 0
    let executeCalls = 0
    let cooldownCalls = 0
    let includeCalls = 0
    let router = commands.create({
        prefix: () => {
            prefixCalls += 1
            return "!"
        },
    })
    router = router.register({
        name: "visible",
        guard: () => {
            guardCalls += 1
            return true
        },
        cooldown: {
            store: {
                claim: () => {
                    cooldownCalls += 1
                    return { _tag: "CooldownAcquired" as const, retryAtMs: Date.now() + 1_000 }
                },
            },
            durationMs: 1_000,
        },
        execute: () => {
            executeCalls += 1
        },
    })
    router = router.register({ name: "hidden", execute: () => undefined })

    const frozen: boolean[] = []
    const pages = router.help({
        prefix: "?",
        maxLength: 1_000,
        include: (metadata) => {
            includeCalls += 1
            frozen.push(Object.isFrozen(metadata))
            return metadata.name === "visible"
        },
    })

    expect(pages).toEqual(["?visible"])
    expect(includeCalls).toBe(2)
    expect(frozen).toEqual([true, true])
    expect(prefixCalls).toBe(0)
    expect(guardCalls).toBe(0)
    expect(executeCalls).toBe(0)
    expect(cooldownCalls).toBe(0)
})

test("default help returns bounded Unicode pages with trimmed edges and supports empty selection reuse", () => {
    let router = commands.create({ prefix: "!" })
    router = router.register({ name: "unicode", description: "😀é😀", execute: () => undefined })
    const full = router.help({ prefix: "!", maxLength: 1_000 })
    const pages = router.help({ prefix: "!", maxLength: 4 })

    expect(full).toEqual(["!unicode\n😀é😀"])
    expect(pages).toEqual(["!uni", "code", "😀é", "😀"])
    expect(pages.every((page) => page.length <= 4)).toBe(true)
    expect(pages.some((page) => /[\uD800-\uDBFF]$/.test(page))).toBe(false)
    expect(pages.some((page) => /^[\uDC00-\uDFFF]/.test(page))).toBe(false)
    expect(helpError(() => router.help({ prefix: "!", maxLength: 1 })).field).toBe("help")
    const malformed = router.register({ name: "malformed", description: "\uD800", execute: () => undefined })
    expect(helpError(() => malformed.help({ prefix: "!", maxLength: 100 })).field).toBe("help")
    expect(Object.isFrozen(pages)).toBe(true)
    expect(router.help({ prefix: "!", maxLength: 4, include: () => false })).toEqual([])
    expect(router.help({ prefix: "!", maxLength: 1_000 })).toEqual(full)
})

test("default help rejects malformed options and unsafe include callbacks without exposing their values", async () => {
    let router = commands.create({ prefix: "!" })
    router = router.register({ name: "registered", execute: () => undefined })
    const invalid = [
        () => router.help({ prefix: "", maxLength: 10 }),
        () => router.help({ prefix: "!", maxLength: 0 }),
        () => router.help({ prefix: "!", maxLength: 10, extra: true } as never),
        () =>
            router.help({
                prefix: "!",
                maxLength: 10,
                include: () => {
                    throw new Error("private include defect")
                },
            }),
        () => router.help({ prefix: "!", maxLength: 10, include: () => 1 as never }),
        () =>
            router.help({
                prefix: "!",
                maxLength: 10,
                include: () => Promise.reject(new Error("private rejected include")) as never,
            }),
    ]

    for (const run of invalid) {
        const error = helpError(run)
        expect(error.field).toBe("help")
        expect(error.message).not.toContain("private")
    }
    // A rejected include promise must not surface later as an unhandled rejection
    await Promise.resolve()
})

test("native help renders synchronously and shares default rendering and validation", () => {
    let includeCalls = 0
    const definition = {
        name: "config",
        aliases: ["cfg"],
        arguments: { file: { type: "text" }, force: { type: "boolean", optional: true } } as const,
    }
    let router = nativeCommands.create({ prefix: "!" })
    router = router.register({ ...definition, execute: () => Effect.void })
    const defaultRouter = commands.create({ prefix: "!" }).register({ ...definition, execute: () => undefined })
    const pages = router.help({
        prefix: "/",
        maxLength: 1_000,
        include: () => {
            includeCalls += 1
            return true
        },
    })
    expect(helpEntries(pages, "/")).toEqual([
        { invocation: "/config <file> [force]", group: false, details: mentions("/cfg") },
    ])
    expect(pages).toEqual(defaultRouter.help({ prefix: "/", maxLength: 1_000 }))
    expect(includeCalls).toBe(1)

    expect(helpError(() => router.help({ prefix: "/", maxLength: 0 })).field).toBe("help")
    expect(helpError(() => router.help({ prefix: "/", maxLength: 1_000, include: () => 1 as never })).field).toBe(
        "help",
    )
    expect(router.help({ prefix: "/", maxLength: 1_000 })).toEqual(pages)
})

test("nested help discovers immediate groups and leaves with descriptions and empty groups", () => {
    let callbacks = 0
    let router = commands.create({
        prefix: () => {
            callbacks += 1
            return "!"
        },
    })
    router = router.register({
        name: "ping",
        description: "Checks connectivity",
        execute: () => {
            callbacks += 1
        },
    })
    router = router.registerGroup({ name: "admin", aliases: ["a"], description: "Administration tools" })
    router = router.register(
        {
            name: "inspect",
            aliases: ["i"],
            description: "Inspects a user",
            arguments: { user: { type: "id", mention: "user" } },
            guard: () => {
                callbacks += 1
                return false
            },
            cooldown: {
                durationMs: 1_000,
                store: {
                    claim: () => {
                        callbacks += 1
                        return { _tag: "CooldownAcquired", retryAtMs: 1 }
                    },
                },
            },
            execute: () => {
                callbacks += 1
            },
        },
        { group: ["admin"] },
    )
    router = router.registerGroup({ name: "users", aliases: ["u"], description: "User tools" }, { group: ["admin"] })
    router = router.register(
        {
            name: "deep",
            execute: () => {
                callbacks += 1
            },
        },
        { group: ["admin", "users"] },
    )
    router = router.registerGroup({ name: "empty", description: "Reserved tools" })

    const help = (group?: readonly string[]) =>
        helpEntries(router.help({ prefix: "!", maxLength: 1_000, ...(group === undefined ? {} : { group }) }), "!")
    // Root help lists only immediate entries, so commands inside groups stay out
    expect(help()).toEqual([
        { invocation: "!ping", group: false, details: "Checks connectivity" },
        { invocation: "!admin", group: true, details: mentions("!a", "Administration tools") },
        { invocation: "!empty", group: true, details: mentions("Reserved tools") },
    ])
    // A selected group shows itself and its immediate children with full paths, but not deeper descendants
    expect(help(["admin"])).toEqual([
        { invocation: "!admin", group: true, details: mentions("!a", "Administration tools") },
        { invocation: "!admin inspect <user>", group: false, details: mentions("!admin i", "Inspects a user") },
        { invocation: "!admin users", group: true, details: mentions("!admin u", "User tools") },
    ])
    expect(help(["admin", "users"])).toEqual([
        { invocation: "!admin users", group: true, details: mentions("!admin u", "User tools") },
        { invocation: "!admin users deep", group: false, details: "" },
    ])
    expect(help(["empty"])).toEqual([{ invocation: "!empty", group: true, details: mentions("Reserved tools") }])
    expect(callbacks).toBe(0)
})

test("nested help checks visibility once for ancestors and immediate entries without exposing hidden paths", () => {
    const router = commands
        .create({ prefix: "!" })
        .registerGroup({ name: "admin" })
        .registerGroup({ name: "users" }, { group: ["admin"] })
        .register({ name: "inspect", execute() {} }, { group: ["admin", "users"] })
    const seen: string[] = []
    const frozen: boolean[] = []
    const visible = router.help({
        prefix: "!",
        maxLength: 1_000,
        group: ["admin", "users"],
        include: (entry) => {
            frozen.push(Object.isFrozen(entry) && Object.isFrozen(entry.path))
            seen.push(`${entry.kind ?? "leaf"}:${entry.path!.join(" ")}`)
            return true
        },
    })
    expect(frozen).toEqual([true, true, true])
    expect(helpEntries(visible, "!").map(({ invocation, group }) => ({ invocation, group }))).toEqual([
        { invocation: "!admin users", group: true },
        { invocation: "!admin users inspect", group: false },
    ])
    expect(seen).toEqual(["group:admin", "group:admin users", "leaf:admin users inspect"])
    seen.length = 0
    expect(
        router.help({
            prefix: "!",
            maxLength: 1_000,
            group: ["admin", "users"],
            include: (entry) => {
                seen.push(entry.name)
                return entry.name !== "admin"
            },
        }),
    ).toEqual([])
    expect(seen).toEqual(["admin"])
    expect(
        router.help({
            prefix: "!",
            maxLength: 1_000,
            group: ["admin", "users"],
            include: (entry) => entry.name !== "users",
        }),
    ).toEqual([])
    const groupsOnly = router.help({
        prefix: "!",
        maxLength: 1_000,
        group: ["admin", "users"],
        include: (entry) => entry.kind === "group",
    })
    expect(helpEntries(groupsOnly, "!").map((entry) => entry.invocation)).toEqual(["!admin users"])
    expect(router.help({ prefix: "!", maxLength: 1_000, include: () => false })).toEqual([])
    const withoutUsers = router.help({
        prefix: "!",
        maxLength: 1_000,
        group: ["admin"],
        include: (entry) => entry.name !== "users",
    })
    expect(helpEntries(withoutUsers, "!").map((entry) => entry.invocation)).toEqual(["!admin"])
})

test("native nested help matches default pagination and fails safely for noncanonical selectors", () => {
    const root = nativeCommands.create({ prefix: "!" })
    const admin = root.registerGroup({ name: "admin", aliases: ["a"], description: "😀 Tools" })
    const router = admin.registerGroup({ name: "users" }, { group: ["admin"] })
    let includeCalls = 0
    const pages = router.help({
        prefix: "!",
        maxLength: 4,
        group: ["admin"],
        include: () => {
            includeCalls += 1
            return true
        },
    })
    expect(includeCalls).toBe(2)
    expect(pages.every((page) => page.length > 0 && page.length <= 4 && page.isWellFormed())).toBe(true)
    expect(pages.join("")).toContain("😀")
    expect(helpEntries(router.help({ prefix: "!", maxLength: 1_000, group: ["admin"] }), "!")).toEqual([
        { invocation: "!admin", group: true, details: mentions("!a", "😀 Tools") },
        { invocation: "!admin users", group: true, details: "(Group)" },
    ])
    for (const group of [["missing-private"], ["a"], new Array(1), "private", ["bad name"]]) {
        const error = helpError(() => router.help({ prefix: "!", maxLength: 100, group: group as never }))
        expect(error.field).toBe("help")
        expect(error.message).not.toContain("private")
    }
})

test.each(["default", "native"] as const)(
    "%s help leaves out hidden commands and hidden groups with their contents, while metadata keeps them",
    (mode) => {
        const execute = mode === "default" ? () => undefined : () => Effect.void
        const created = mode === "default" ? commands.create({ prefix: "!" }) : nativeCommands.create({ prefix: "!" })
        const router = (created as unknown as ReturnType<typeof commands.create>)
            .register({ name: "ping", execute })
            .register({ name: "shutdown", hidden: true, execute })
            .registerGroup({ name: "secret", hidden: true })
            .registerGroup({ name: "nested" }, { group: ["secret"] })
            .register({ name: "inspect", execute }, { group: ["secret", "nested"] })
            .registerGroup({ name: "tools" })
            .register({ name: "trace", hidden: true, execute }, { group: ["tools"] })
            .register({ name: "status", execute }, { group: ["tools"] })
        const seen: string[] = []
        const include = (entry: { readonly name: string }) => {
            seen.push(entry.name)
            return true
        }

        const invocations = (group?: readonly string[]) =>
            helpEntries(
                router.help({ prefix: "!", maxLength: 1_000, include, ...(group === undefined ? {} : { group }) }),
                "!",
            ).map((entry) => entry.invocation)
        expect(invocations()).toEqual(["!ping", "!tools"])
        expect(invocations(["tools"])).toEqual(["!tools", "!tools status"])
        // The include callback never sees hidden entries
        expect(seen).toEqual(["ping", "tools", "tools", "status"])
        // A hidden group and the groups inside it look missing to help
        for (const group of [["secret"], ["secret", "nested"]])
            expect(helpError(() => router.help({ prefix: "!", maxLength: 1_000, group })).field).toBe("help")
        expect(router.commands.filter((command) => command.hidden === true).map((command) => command.name)).toEqual([
            "shutdown",
            "trace",
        ])
        expect(router.groups.find((group) => group.name === "secret")?.hidden).toBe(true)
    },
)
