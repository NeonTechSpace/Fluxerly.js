import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as native from "../../src/effect.js"
import * as defaultApi from "../../src/index.js"
import { expectErr } from "../support/settle.js"

const guildChannel = { id: "1750000000000000000", guildId: "1750000000000000001" }
const directMessage = { id: "1750000000000000002" }
const message = { id: "1750000000000000003", channelId: guildChannel.id }
const apis = [
    ["default", defaultApi],
    ["effect", native],
] as const

afterEach(() => vi.unstubAllGlobals())

function thrown(run: () => unknown): unknown {
    try {
        run()
    } catch (error) {
        return error
    }
    throw Error("Expected the helper to throw")
}

for (const [mode, api] of apis) {
    test(`${mode}: formats and parses Fluxer markup as plain values without fetching`, () => {
        let fetches = 0
        vi.stubGlobal("fetch", () => {
            fetches += 1
            throw Error("Pure helpers must not fetch")
        })
        const id = "1750000000000000000"
        const date = new Date("2026-09-09T12:34:56.789Z")

        expect(api.format.escapeMarkdown("@everyone: **literal** <#10>")).toBe(
            "\\@everyone\\: \\*\\*literal\\*\\* \\<\\#10\\>",
        )
        expect(api.format.userMention(id)).toBe(`<@${id}>`)
        expect(api.format.roleMention(id)).toBe(`<@&${id}>`)
        expect(api.format.channelMention(id)).toBe(`<#${id}>`)
        expect(api.format.parseMention(`<@!${id}>`)).toEqual({ kind: "user", id })
        expect(api.format.parseMention(`<@&${id}>`)).toEqual({ kind: "role", id })
        expect(api.format.parseMention(`<#${id}>`)).toEqual({ kind: "channel", id })
        expect(api.format.timestamp(date, api.TimestampStyles.RelativeTime)).toBe(
            `<t:${Math.floor(date.getTime() / 1_000)}:R>`,
        )
        expect(api.format.timestamp(date)).toBe(`<t:${Math.floor(date.getTime() / 1_000)}:f>`)
        expect(api.format.parseTimestamp("<t:1788957296:R>")).toMatchObject({
            date: new Date("2026-09-09T12:34:56.000Z"),
            style: api.TimestampStyles.RelativeTime,
        })
        expect(api.format.customEmoji({ name: "build-pass", id, animated: true })).toBe(`<a:build-pass:${id}>`)
        expect(api.format.parseCustomEmoji(`<a:build-pass:${id}>`)).toEqual({ name: "build-pass", id, animated: true })
        expect(fetches).toBe(0)
    })

    test(`${mode}: throws HelperError for malformed markup passed to the plain format helpers`, () => {
        for (const id of ["", "01", "9223372036854775808"])
            expect(thrown(() => api.format.userMention(id))).toMatchObject({
                _tag: "HelperError",
                operation: "format.userMention",
                reason: "id",
                // The message says which form the helper accepts
                message: expect.stringContaining("decimal strings"),
            })
        expect(thrown(() => api.format.parseMention("<@not-an-id>"))).toMatchObject({
            operation: "format.parseMention",
            reason: "markup",
        })
        expect(thrown(() => api.format.parseTimestamp("<t:0:f>"))).toMatchObject({
            _tag: "HelperError",
            operation: "format.parseTimestamp",
            reason: "time",
        })
        expect(thrown(() => api.format.parseCustomEmoji("<:bad name:1750000000000000000>"))).toMatchObject({
            operation: "format.parseCustomEmoji",
            reason: "markup",
        })
        expect(thrown(() => api.format.timestamp(new Date(Number.NaN)))).toMatchObject({
            operation: "format.timestamp",
            reason: "time",
        })
    })

    test(`${mode}: converts snowflakes and produces exact bigint cursor boundaries as plain values`, () => {
        const epoch = new Date("2015-01-01T00:00:00.000Z")
        const date = new Date("2026-09-09T12:34:56.789Z")
        const expectedBoundary = ((BigInt(date.getTime()) - 1_420_070_400_000n) << 22n).toString()

        expect(api.snowflakes.isValid(expectedBoundary)).toBe(true)
        expect(api.snowflakes.isValid("01")).toBe(false)
        expect(api.snowflakes.parse(expectedBoundary)).toBe(BigInt(expectedBoundary))
        expect(api.snowflakes.boundary(epoch)).toBe("0")
        expect(api.snowflakes.boundary(date)).toBe(expectedBoundary)
        expect(api.snowflakes.createdAt(expectedBoundary).toISOString()).toBe("2026-09-09T12:34:56.789Z")
        expect(thrown(() => api.snowflakes.boundary(new Date("2014-12-31T23:59:59.999Z")))).toMatchObject({
            _tag: "HelperError",
            operation: "snowflakes.boundary",
            reason: "time",
        })
        expect(thrown(() => api.snowflakes.parse("01"))).toMatchObject({ operation: "snowflakes.parse", reason: "id" })
        expect(thrown(() => api.snowflakes.createdAt("x"))).toMatchObject({
            operation: "snowflakes.createdAt",
            reason: "id",
        })
    })

    test(`${mode}: shardFor routes a community ID to Fluxer's shard and rejects invalid input`, () => {
        // Fluxer routes by (id >> 22) % totalShards
        const id = ((5n << 22n) | 12_345n).toString()
        expect(api.snowflakes.shardFor(id, 1)).toBe(0)
        expect(api.snowflakes.shardFor(id, 3)).toBe(2)
        expect(api.snowflakes.shardFor(id, 16_384)).toBe(5)
        expect(api.snowflakes.shardFor("9223372036854775807", 7)).toBe(Number((((1n << 63n) - 1n) >> 22n) % 7n))
        expect(thrown(() => api.snowflakes.shardFor("01", 2))).toMatchObject({
            _tag: "HelperError",
            operation: "snowflakes.shardFor",
            reason: "id",
        })
        for (const totalShards of [0, 16_385, 1.5, Number.NaN, "2" as unknown as number])
            expect(thrown(() => api.snowflakes.shardFor(id, totalShards))).toMatchObject({
                operation: "snowflakes.shardFor",
                reason: "shardCount",
                message: expect.stringContaining("1 through 16,384"),
            })
    })

    test(`${mode}: applies display, named permissions, decimal serialization, and hosted guild/direct-message link contracts`, () => {
        expect(api.display.name({ username: "user", displayName: "Display" })).toBe("Display")
        expect(api.display.name({ username: "user", displayName: null }, { nickname: "Guild name" })).toBe("Guild name")
        expect(api.display.name({ username: "user", displayName: null }, { nickname: null })).toBe("user")
        expect(api.display.name({ username: "user" })).toBe("user")
        expect(api.permissionBits.has(api.Permissions.ManageGuild, "ManageGuild")).toBe(true)
        expect(api.permissionBits.has(api.Permissions.ManageGuild, "ManageChannels")).toBe(false)
        expect(api.permissionBits.toDecimal((1n << 63n) | api.Permissions.ManageGuild)).toBe("9223372036854775840")
        expect(thrown(() => api.permissionBits.toDecimal(-1n))).toMatchObject({
            _tag: "HelperError",
            operation: "permissionBits.toDecimal",
            reason: "permissionBits",
        })
        expect(thrown(() => api.permissionBits.has(0n, "NotAPermission" as never))).toMatchObject({
            operation: "permissionBits.has",
            reason: "permissionBits",
        })

        expect(api.links.channel(guildChannel)).toBe(
            `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}`,
        )
        expect(api.links.channel(directMessage)).toBe(`https://fluxer.app/channels/@me/${directMessage.id}`)
        expect(api.links.message(message, guildChannel)).toBe(
            `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}/${message.id}`,
        )
        expect(
            thrown(() => api.links.message({ ...message, channelId: directMessage.id }, guildChannel)),
        ).toMatchObject({ operation: "links.message", reason: "link" })
        expect(api.links.installation(guildChannel.id)).toBe(
            `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot`,
        )
        expect(api.links.installation(guildChannel.id, { permissions: 0n })).toBe(
            `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=0`,
        )
        expect(api.links.installation(guildChannel.id, { permissions: 1n << 63n })).toBe(
            `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=9223372036854775808`,
        )
    })

    test(`${mode}: rejects noncanonical installation IDs and options without alternate hosted routes, scopes, or requests`, () => {
        for (const [id, options, reason] of [
            ["01", undefined, "id"],
            [guildChannel.id, { permissions: -1n }, "permissionBits"],
            [guildChannel.id, { permissions: 1n << 64n }, "permissionBits"],
            [guildChannel.id, { scope: "identify" }, "link"],
        ] as const)
            expect(thrown(() => api.links.installation(id, options as never))).toMatchObject({
                _tag: "HelperError",
                operation: "links.installation",
                reason,
            })
    })
}

test("default try parsers return Ok for valid text and Err with the plain helper's error for invalid text", () => {
    const id = "1750000000000000000"
    expect(defaultApi.format.tryParseMention(`<@&${id}>`)._unsafeUnwrap()).toEqual({ kind: "role", id })
    expect(defaultApi.format.tryParseTimestamp("<t:1788957296>")._unsafeUnwrap()).toEqual({
        date: new Date("2026-09-09T12:34:56.000Z"),
        style: defaultApi.TimestampStyles.ShortDateTime,
    })
    expect(defaultApi.format.tryParseCustomEmoji(`<:party:${id}>`)._unsafeUnwrap()).toEqual({ name: "party", id })
    expect(defaultApi.snowflakes.tryParse(id)._unsafeUnwrap()).toBe(BigInt(id))
    expect(defaultApi.colors.tryParse("#ff8800")._unsafeUnwrap()).toBe(0xff8800)

    for (const [attempt, plain] of [
        [() => defaultApi.format.tryParseMention("<@01>"), () => defaultApi.format.parseMention("<@01>")],
        [() => defaultApi.format.tryParseTimestamp("<t:0>"), () => defaultApi.format.parseTimestamp("<t:0>")],
        [
            () => defaultApi.format.tryParseCustomEmoji("<:bad name:1>"),
            () => defaultApi.format.parseCustomEmoji("<:bad name:1>"),
        ],
        [() => defaultApi.snowflakes.tryParse("01"), () => defaultApi.snowflakes.parse("01")],
        [() => defaultApi.colors.tryParse("red"), () => defaultApi.colors.parse("red")],
        [() => defaultApi.format.tryParseMention(1 as never), () => defaultApi.format.parseMention(1 as never)],
    ] as const) {
        const result = attempt()
        expect(result.isErr()).toBe(true)
        const expected = thrown(plain) as defaultApi.HelperError
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(defaultApi.HelperError)
        expect(result._unsafeUnwrapErr()).toMatchObject({ operation: expected.operation, reason: expected.reason })
    }
})

test("native try parsers read text when run, succeed for valid text and fail with the plain helper's error", async () => {
    const id = "1750000000000000000"
    expect(await Effect.runPromise(native.format.tryParseMention(`<@!${id}>`))).toEqual({ kind: "user", id })
    expect(await Effect.runPromise(native.format.tryParseTimestamp("<t:1788957296:R>"))).toEqual({
        date: new Date("2026-09-09T12:34:56.000Z"),
        style: native.TimestampStyles.RelativeTime,
    })
    expect(await Effect.runPromise(native.format.tryParseCustomEmoji(`<a:party:${id}>`))).toEqual({
        name: "party",
        id,
        animated: true,
    })
    expect(await Effect.runPromise(native.snowflakes.tryParse(id))).toBe(BigInt(id))
    expect(await Effect.runPromise(native.colors.tryParse([255, 136, 0]))).toBe(0xff8800)

    const rgb: [number, number, number] = [1, 2, 3]
    const deferred = native.colors.tryParse(rgb)
    rgb[0] = 4
    expect(await Effect.runPromise(deferred)).toBe(0x040203)

    for (const [attempt, plain] of [
        [() => native.format.tryParseMention("<@01>"), () => native.format.parseMention("<@01>")],
        [() => native.format.tryParseTimestamp("<t:0>"), () => native.format.parseTimestamp("<t:0>")],
        [
            () => native.format.tryParseCustomEmoji("<:bad name:1>"),
            () => native.format.parseCustomEmoji("<:bad name:1>"),
        ],
        [() => native.snowflakes.tryParse("01"), () => native.snowflakes.parse("01")],
        [() => native.colors.tryParse("red"), () => native.colors.parse("red")],
    ] as const) {
        const effect: Effect.Effect<unknown, native.HelperError> = attempt()
        const expected = thrown(plain) as native.HelperError
        const error = await expectErr(effect)
        expect(error).toBeInstanceOf(native.HelperError)
        expect(error).toMatchObject({ operation: expected.operation, reason: expected.reason })
    }
})

test("native plain helpers throwing inside Effect code become defects rather than typed failures", async () => {
    const exit = await Effect.runPromiseExit(Effect.sync(() => native.format.userMention("01")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(false)
        expect(exit.cause.reasons.find((reason) => reason._tag === "Die")).toMatchObject({
            defect: { _tag: "HelperError", operation: "format.userMention", reason: "id" },
        })
    }
})
