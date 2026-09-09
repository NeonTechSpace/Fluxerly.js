import { Effect, Exit } from "effect"
import type { Result } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import * as native from "../src/effect.js"
import * as defaultApi from "../src/index.js"

const guildChannel = { id: "1750000000000000000", guildId: "1750000000000000001" }
const directMessage = { id: "1750000000000000002" }
const message = { id: "1750000000000000003", channelId: guildChannel.id }

afterEach(() => vi.unstubAllGlobals())

function value<A, E>(result: Result<A, E>): A {
    if (!result.isOk()) throw result.error
    return result.value
}

async function nativeError(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
    const exit = await Effect.runPromiseExit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) throw Error("Expected native helper failure")
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (!failure || failure._tag !== "Fail") throw Error("Expected native helper failure")
    return failure.error
}

test("formats and parses Fluxer markup through both public entries without fetching", async () => {
    let fetches = 0
    vi.stubGlobal("fetch", () => {
        fetches += 1
        throw Error("Pure helpers must not fetch")
    })
    const id = "1750000000000000000"
    const date = new Date("2026-09-09T12:34:56.789Z")

    expect(defaultApi.format.escapeMarkdown("@everyone: **literal** <#10>")).toBe(
        "\\@everyone\\: \\*\\*literal\\*\\* \\<\\#10\\>",
    )
    expect(value(defaultApi.format.userMention(id))).toBe(`<@${id}>`)
    expect(value(defaultApi.format.roleMention(id))).toBe(`<@&${id}>`)
    expect(value(defaultApi.format.channelMention(id))).toBe(`<#${id}>`)
    expect(value(defaultApi.format.parseMention(`<@!${id}>`))).toEqual({ kind: "user", id })
    expect(value(defaultApi.format.parseMention(`<@&${id}>`))).toEqual({ kind: "role", id })
    expect(value(defaultApi.format.parseMention(`<#${id}>`))).toEqual({ kind: "channel", id })
    expect(value(defaultApi.format.timestamp(date, defaultApi.TimestampStyles.RelativeTime))).toBe(
        `<t:${Math.floor(date.getTime() / 1_000)}:R>`,
    )
    expect(value(defaultApi.format.parseTimestamp("<t:1788957296:R>"))).toMatchObject({
        date: new Date("2026-09-09T12:34:56.000Z"),
        style: defaultApi.TimestampStyles.RelativeTime,
    })
    expect(value(defaultApi.format.customEmoji({ name: "build-pass", id, animated: true }))).toBe(
        `<a:build-pass:${id}>`,
    )
    expect(value(defaultApi.format.parseCustomEmoji(`<a:build-pass:${id}>`))).toEqual({
        name: "build-pass",
        id,
        animated: true,
    })

    expect(await Effect.runPromise(native.format.userMention(id))).toBe(`<@${id}>`)
    expect(await Effect.runPromise(native.format.parseMention(`<@!${id}>`))).toEqual({ kind: "user", id })
    expect(await Effect.runPromise(native.format.timestamp(date, native.TimestampStyles.RelativeTime))).toBe(
        `<t:${Math.floor(date.getTime() / 1_000)}:R>`,
    )
    expect(await Effect.runPromise(native.format.parseCustomEmoji(`<a:build-pass:${id}>`))).toEqual({
        name: "build-pass",
        id,
        animated: true,
    })
    expect(fetches).toBe(0)
})

test("reports malformed markup as HelperError through Result and Effect", async () => {
    for (const id of ["", "01", "9223372036854775808"]) {
        const defaultResult = defaultApi.format.userMention(id)
        expect(defaultResult.isErr()).toBe(true)
        if (defaultResult.isErr())
            expect(defaultResult.error).toMatchObject({
                _tag: "HelperError",
                operation: "format.userMention",
                reason: "id",
            })

        await expect(nativeError(native.format.userMention(id))).resolves.toMatchObject({
            _tag: "HelperError",
            operation: "format.userMention",
            reason: "id",
        })
    }

    expect(defaultApi.format.parseMention("<@not-an-id>").isErr()).toBe(true)
    expect(defaultApi.format.parseTimestamp("<t:0:f>").isErr()).toBe(true)
    expect(defaultApi.format.parseCustomEmoji("<:bad name:1750000000000000000>").isErr()).toBe(true)
    await expect(nativeError(native.format.parseTimestamp("<t:0:f>"))).resolves.toMatchObject({
        _tag: "HelperError",
        operation: "format.parseTimestamp",
        reason: "time",
    })
})

test("defers native timestamp validation until Effect execution", async () => {
    const date = new Date(0)
    const timestamp = native.format.timestamp(date, native.TimestampStyles.RelativeTime)
    date.setTime(new Date("2026-09-09T12:34:56.789Z").getTime())

    expect(await Effect.runPromise(timestamp)).toBe("<t:1788957296:R>")
})

test("extracts snowflake creation time and produces exact bigint cursor boundaries through both public entries", async () => {
    const epoch = new Date("2015-01-01T00:00:00.000Z")
    const date = new Date("2026-09-09T12:34:56.789Z")
    const expectedBoundary = ((BigInt(date.getTime()) - 1_420_070_400_000n) << 22n).toString()

    expect(defaultApi.snowflakes.isValid(expectedBoundary)).toBe(true)
    expect(defaultApi.snowflakes.isValid("01")).toBe(false)
    expect(value(defaultApi.snowflakes.parse(expectedBoundary))).toBe(BigInt(expectedBoundary))
    expect(value(defaultApi.snowflakes.boundary(epoch))).toBe("0")
    expect(value(defaultApi.snowflakes.boundary(date))).toBe(expectedBoundary)
    expect(value(defaultApi.snowflakes.createdAt(expectedBoundary)).toISOString()).toBe("2026-09-09T12:34:56.789Z")

    expect(await Effect.runPromise(native.snowflakes.parse(expectedBoundary))).toBe(BigInt(expectedBoundary))
    expect(await Effect.runPromise(native.snowflakes.boundary(date))).toBe(expectedBoundary)
    expect((await Effect.runPromise(native.snowflakes.createdAt(expectedBoundary))).toISOString()).toBe(
        "2026-09-09T12:34:56.789Z",
    )
    await expect(nativeError(native.snowflakes.boundary(new Date("2014-12-31T23:59:59.999Z")))).resolves.toMatchObject({
        _tag: "HelperError",
        operation: "snowflakes.boundary",
        reason: "time",
    })
})

test("applies display, named permissions, decimal serialization, and hosted guild/direct-message link contracts", async () => {
    expect(defaultApi.display.name({ username: "user", displayName: "Display" })).toBe("Display")
    expect(defaultApi.display.name({ username: "user", displayName: null }, { nickname: "Guild name" })).toBe(
        "Guild name",
    )
    expect(defaultApi.display.name({ username: "user", displayName: null }, { nickname: null })).toBe("user")
    expect(value(defaultApi.permissionBits.has(defaultApi.Permissions.ManageGuild, "ManageGuild"))).toBe(true)
    expect(value(defaultApi.permissionBits.has(defaultApi.Permissions.ManageGuild, "ManageChannels"))).toBe(false)
    expect(value(defaultApi.permissionBits.toDecimal((1n << 63n) | defaultApi.Permissions.ManageGuild))).toBe(
        "9223372036854775840",
    )
    expect(defaultApi.permissionBits.toDecimal(-1n).isErr()).toBe(true)
    expect(defaultApi.permissionBits.has(0n, "NotAPermission" as never).isErr()).toBe(true)

    expect(value(defaultApi.links.channel(guildChannel))).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}`,
    )
    expect(value(defaultApi.links.channel(directMessage))).toBe(`https://fluxer.app/channels/@me/${directMessage.id}`)
    expect(value(defaultApi.links.message(message, guildChannel))).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}/${message.id}`,
    )
    expect(defaultApi.links.message({ ...message, channelId: directMessage.id }, guildChannel).isErr()).toBe(true)
    expect(value(defaultApi.links.installation(guildChannel.id))).toBe(
        `https://fluxer.app/oauth2/authorize?client_id=${guildChannel.id}&scope=bot`,
    )
    expect(value(defaultApi.links.installation(guildChannel.id, { permissions: 1n << 63n }))).toBe(
        `https://fluxer.app/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=9223372036854775808`,
    )

    expect(await Effect.runPromise(native.permissionBits.has(native.Permissions.ManageGuild, "ManageGuild"))).toBe(true)
    expect(await Effect.runPromise(native.permissionBits.toDecimal(1n << 63n))).toBe("9223372036854775808")
    expect(await Effect.runPromise(native.links.channel(guildChannel))).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}`,
    )
    expect(await Effect.runPromise(native.links.message(message, guildChannel))).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}/${message.id}`,
    )
    expect(await Effect.runPromise(native.links.installation(guildChannel.id, { permissions: 0n }))).toBe(
        `https://fluxer.app/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=0`,
    )
    await expect(nativeError(native.permissionBits.toDecimal(-1n))).resolves.toMatchObject({
        _tag: "HelperError",
        operation: "permissionBits.toDecimal",
        reason: "permissionBits",
    })
})

test("rejects noncanonical installation IDs and options without alternate hosted routes, scopes, or requests", async () => {
    for (const [id, options, reason] of [
        ["01", undefined, "id"],
        [guildChannel.id, { permissions: -1n }, "permissionBits"],
        [guildChannel.id, { permissions: 1n << 64n }, "permissionBits"],
        [guildChannel.id, { scope: "identify" }, "link"],
    ] as const) {
        const defaultResult = defaultApi.links.installation(id, options as never)
        expect(defaultResult).toMatchObject({
            error: { _tag: "HelperError", operation: "links.installation", reason },
        })
        await expect(nativeError(native.links.installation(id, options as never))).resolves.toMatchObject({
            _tag: "HelperError",
            operation: "links.installation",
            reason,
        })
    }
})
