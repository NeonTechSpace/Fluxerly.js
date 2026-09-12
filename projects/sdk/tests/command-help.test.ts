import { Effect } from "effect"
import { expect, test } from "vitest"
import { commands } from "../src/index.js"
import { commands as nativeCommands } from "../src/effect.js"

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

test("default help renders registration order, generated signatures, legacy usage and aliases", () => {
    let router = value(commands.create({ prefix: "unused" }))
    router = value(
        router.register({
            name: "deploy",
            aliases: ["d", "ship"],
            description: "Deploys the selected service",
            arguments: {
                service: { type: "text" },
                version: { type: "integer", optional: true },
                note: { type: "text", rest: true, optional: true },
            } as const,
            execute: () => undefined,
        }),
    )
    router = value(
        router.register({
            name: "status",
            usage: "",
            description: "",
            arguments: { target: { type: "text" } } as const,
            execute: () => undefined,
        }),
    )
    router = value(
        router.register({
            name: "restart",
            usage: "service --force",
            arguments: { ignored: { type: "text" } } as const,
            execute: () => undefined,
        }),
    )

    expect(value(router.help({ prefix: "!", maxLength: 1_000 }))).toEqual([
        "!deploy <service> [version] [note...] (Aliases: !d, !ship)\nDeploys the selected service\n\n!status\n\n!restart service --force",
    ])
})

test("default help filters frozen metadata once without running command callbacks or prefix resolution", () => {
    let prefixCalls = 0
    let guardCalls = 0
    let executeCalls = 0
    let cooldownCalls = 0
    let includeCalls = 0
    let router = value(
        commands.create({
            prefix: () => {
                prefixCalls += 1
                return "!"
            },
        }),
    )
    router = value(
        router.register({
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
        }),
    )
    router = value(router.register({ name: "hidden", execute: () => undefined }))

    const pages = value(
        router.help({
            prefix: "?",
            maxLength: 1_000,
            include: (metadata) => {
                includeCalls += 1
                expect(Object.isFrozen(metadata)).toBe(true)
                return metadata.name === "visible"
            },
        }),
    )

    expect(pages).toEqual(["?visible"])
    expect(includeCalls).toBe(2)
    expect(prefixCalls).toBe(0)
    expect(guardCalls).toBe(0)
    expect(executeCalls).toBe(0)
    expect(cooldownCalls).toBe(0)
})

test("default help returns bounded Unicode pages with trimmed edges and supports empty selection reuse", () => {
    let router = value(commands.create({ prefix: "!" }))
    router = value(router.register({ name: "unicode", description: "😀é😀", execute: () => undefined }))
    const full = value(router.help({ prefix: "!", maxLength: 1_000 }))
    const pages = value(router.help({ prefix: "!", maxLength: 4 }))

    expect(full).toEqual(["!unicode\n😀é😀"])
    expect(pages).toEqual(["!uni", "code", "😀é", "😀"])
    expect(pages.every((page) => page.length <= 4)).toBe(true)
    expect(pages.some((page) => /[\uD800-\uDBFF]$/.test(page))).toBe(false)
    expect(pages.some((page) => /^[\uDC00-\uDFFF]/.test(page))).toBe(false)
    const tooSmall = router.help({ prefix: "!", maxLength: 1 })
    expect(tooSmall.isErr() && tooSmall.error.field).toBe("help")
    const malformed = value(
        router.register({ name: "malformed", description: "\uD800", execute: () => undefined }),
    ).help({ prefix: "!", maxLength: 100 })
    expect(malformed.isErr() && malformed.error.field).toBe("help")
    expect(Object.isFrozen(pages)).toBe(true)
    expect(value(router.help({ prefix: "!", maxLength: 4, include: () => false }))).toEqual([])
    expect(value(router.help({ prefix: "!", maxLength: 1_000 }))).toEqual(full)
})

test("default help rejects malformed options and unsafe include callbacks without exposing their values", async () => {
    let router = value(commands.create({ prefix: "!" }))
    router = value(router.register({ name: "registered", execute: () => undefined }))
    const invalidPrefix = router.help({ prefix: "", maxLength: 10 })
    const invalidLength = router.help({ prefix: "!", maxLength: 0 })
    const unsupported = router.help({ prefix: "!", maxLength: 10, extra: true } as never)
    const thrown = router.help({
        prefix: "!",
        maxLength: 10,
        include: () => {
            throw new Error("private include defect")
        },
    })
    const nonboolean = router.help({ prefix: "!", maxLength: 10, include: () => 1 as never })
    const thenable = router.help({
        prefix: "!",
        maxLength: 10,
        include: () => Promise.reject(new Error("private rejected include")) as never,
    })

    for (const result of [invalidPrefix, invalidLength, unsupported, thrown, nonboolean, thenable]) {
        expect(result.isErr() && result.error.field).toBe("help")
        if (result.isErr()) expect(result.error.message).not.toContain("private")
    }
    await Promise.resolve()
})

test("native help stays lazy and shares default rendering and validation", async () => {
    let includeCalls = 0
    let router = await Effect.runPromise(nativeCommands.create({ prefix: "!" }))
    router = await Effect.runPromise(
        router.register({
            name: "config",
            aliases: ["cfg"],
            arguments: { file: { type: "text" }, force: { type: "boolean", optional: true } } as const,
            execute: () => Effect.void,
        }),
    )
    const operation = router.help({
        prefix: "/",
        maxLength: 1_000,
        include: () => {
            includeCalls += 1
            return true
        },
    })
    expect(includeCalls).toBe(0)
    expect(await Effect.runPromise(operation)).toEqual(["/config <file> [force] (Aliases: /cfg)"])
    expect(includeCalls).toBe(1)

    const invalid = await Effect.runPromise(Effect.result(router.help({ prefix: "/", maxLength: 0 })))
    expect(invalid._tag).toBe("Failure")
    if (invalid._tag === "Failure") expect(invalid.failure.field).toBe("help")

    const invalidInclude = await Effect.runPromise(
        Effect.result(router.help({ prefix: "/", maxLength: 1_000, include: () => 1 as never })),
    )
    expect(invalidInclude._tag).toBe("Failure")
    if (invalidInclude._tag === "Failure") expect(invalidInclude.failure.field).toBe("help")
    expect(await Effect.runPromise(router.help({ prefix: "/", maxLength: 1_000 }))).toEqual([
        "/config <file> [force] (Aliases: /cfg)",
    ])
})
