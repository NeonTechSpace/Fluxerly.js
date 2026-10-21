import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as native from "../../src/effect.js"
import * as defaultApi from "../../src/index.js"
import { expectErr } from "../support/settle.js"

const guildChannel = { id: "1750000000000000000", guildId: "1750000000000000001" }
const directMessage = { id: "1750000000000000002" }
const message = { id: "1750000000000000003", channelId: guildChannel.id }

afterEach(() => vi.unstubAllGlobals())

test("the effect entry shares the plain helpers and builders with the default entry", () => {
    for (const name of [
        "builders",
        "display",
        "EmbedBuilder",
        "HelperError",
        "links",
        "MessageBuilder",
        "permissionBits",
        "Permissions",
        "text",
        "assets",
    ] as const)
        expect(native[name], name).toBe(defaultApi[name])
    // These namespaces differ only in the Effect try parsers, which the tests below cover
    for (const name of ["format", "snowflakes", "colors"] as const)
        for (const [key, helper] of Object.entries(defaultApi[name]))
            if (!key.startsWith("try"))
                expect((native[name] as Record<string, unknown>)[key], `${name}.${key}`).toBe(helper)
})

function thrown(run: () => unknown): unknown {
    try {
        run()
    } catch (error) {
        return error
    }
    throw Error("Expected the helper to throw")
}

test("formats and parses Fluxer markup as plain values without fetching", () => {
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
    expect(defaultApi.format.userMention(id)).toBe(`<@${id}>`)
    expect(defaultApi.format.roleMention(id)).toBe(`<@&${id}>`)
    expect(defaultApi.format.channelMention(id)).toBe(`<#${id}>`)
    expect(defaultApi.format.parseMention(`<@!${id}>`)).toEqual({ kind: "user", id })
    expect(defaultApi.format.parseMention(`<@&${id}>`)).toEqual({ kind: "role", id })
    expect(defaultApi.format.parseMention(`<#${id}>`)).toEqual({ kind: "channel", id })
    expect(defaultApi.format.timestamp(date, defaultApi.TimestampStyles.RelativeTime)).toBe(
        `<t:${Math.floor(date.getTime() / 1_000)}:R>`,
    )
    expect(defaultApi.format.timestamp(date)).toBe(`<t:${Math.floor(date.getTime() / 1_000)}:f>`)
    expect(defaultApi.format.parseTimestamp("<t:1788957296:R>")).toMatchObject({
        date: new Date("2026-09-09T12:34:56.000Z"),
        style: defaultApi.TimestampStyles.RelativeTime,
    })
    expect(defaultApi.format.customEmoji({ name: "build-pass", id, animated: true })).toBe(`<a:build-pass:${id}>`)
    expect(defaultApi.format.parseCustomEmoji(`<a:build-pass:${id}>`)).toEqual({
        name: "build-pass",
        id,
        animated: true,
    })
    expect(fetches).toBe(0)
})

test("throws HelperError for malformed markup passed to the plain format helpers", () => {
    for (const id of ["", "01", "9223372036854775808"])
        expect(thrown(() => defaultApi.format.userMention(id))).toMatchObject({
            _tag: "HelperError",
            operation: "format.userMention",
            reason: "id",
            // The message says which form the helper accepts
            message: expect.stringContaining("decimal strings"),
        })
    expect(thrown(() => defaultApi.format.parseMention("<@not-an-id>"))).toMatchObject({
        operation: "format.parseMention",
        reason: "markup",
    })
    expect(thrown(() => defaultApi.format.parseTimestamp("<t:0:f>"))).toMatchObject({
        _tag: "HelperError",
        operation: "format.parseTimestamp",
        reason: "time",
    })
    expect(thrown(() => defaultApi.format.parseCustomEmoji("<:bad name:1750000000000000000>"))).toMatchObject({
        operation: "format.parseCustomEmoji",
        reason: "markup",
    })
    expect(thrown(() => defaultApi.format.timestamp(new Date(Number.NaN)))).toMatchObject({
        operation: "format.timestamp",
        reason: "time",
    })
})

test("converts snowflakes and produces exact bigint cursor boundaries as plain values", () => {
    const epoch = new Date("2015-01-01T00:00:00.000Z")
    const date = new Date("2026-09-09T12:34:56.789Z")
    const expectedBoundary = ((BigInt(date.getTime()) - 1_420_070_400_000n) << 22n).toString()

    expect(defaultApi.snowflakes.isValid(expectedBoundary)).toBe(true)
    expect(defaultApi.snowflakes.isValid("01")).toBe(false)
    expect(defaultApi.snowflakes.parse(expectedBoundary)).toBe(BigInt(expectedBoundary))
    expect(defaultApi.snowflakes.boundary(epoch)).toBe("0")
    expect(defaultApi.snowflakes.boundary(date)).toBe(expectedBoundary)
    expect(defaultApi.snowflakes.createdAt(expectedBoundary).toISOString()).toBe("2026-09-09T12:34:56.789Z")
    expect(thrown(() => defaultApi.snowflakes.boundary(new Date("2014-12-31T23:59:59.999Z")))).toMatchObject({
        _tag: "HelperError",
        operation: "snowflakes.boundary",
        reason: "time",
    })
    expect(thrown(() => defaultApi.snowflakes.parse("01"))).toMatchObject({
        operation: "snowflakes.parse",
        reason: "id",
    })
    expect(thrown(() => defaultApi.snowflakes.createdAt("x"))).toMatchObject({
        operation: "snowflakes.createdAt",
        reason: "id",
    })
})

test("shardFor routes a community ID to Fluxer's shard and rejects invalid input", () => {
    // Fluxer routes by (id >> 22) % totalShards
    const id = ((5n << 22n) | 12_345n).toString()
    expect(defaultApi.snowflakes.shardFor(id, 1)).toBe(0)
    expect(defaultApi.snowflakes.shardFor(id, 3)).toBe(2)
    expect(defaultApi.snowflakes.shardFor(id, 16_384)).toBe(5)
    expect(defaultApi.snowflakes.shardFor("9223372036854775807", 7)).toBe(Number((((1n << 63n) - 1n) >> 22n) % 7n))
    expect(thrown(() => defaultApi.snowflakes.shardFor("01", 2))).toMatchObject({
        _tag: "HelperError",
        operation: "snowflakes.shardFor",
        reason: "id",
    })
    for (const totalShards of [0, 16_385, 1.5, Number.NaN, "2" as unknown as number])
        expect(thrown(() => defaultApi.snowflakes.shardFor(id, totalShards))).toMatchObject({
            operation: "snowflakes.shardFor",
            reason: "shardCount",
            message: expect.stringContaining("1 through 16,384"),
        })
})

test("label gives Fluxer's name for every permission and rejects unknown names", () => {
    const names = Object.keys(defaultApi.Permissions) as defaultApi.PermissionName[]
    const labels = names.map((name) => defaultApi.permissionBits.label(name))
    // Every permission has its own label
    expect(new Set(labels).size).toBe(names.length)
    expect(defaultApi.permissionBits.label("ManageGuild")).toBe("Manage community")
    expect(defaultApi.permissionBits.label("ModerateMembers")).toBe("Time out members")
    expect(defaultApi.permissionBits.label("UseVad")).toBe("Use voice activity")
    expect(defaultApi.permissionBits.label("SendTtsMessages")).toBe("Send TTS messages")
    expect(defaultApi.permissionBits.label("MentionEveryone")).toBe("Use @everyone/@here and @roles")
    expect(defaultApi.permissionBits.label("ManageExpressions")).toBe("Manage emoji & stickers")
    expect(defaultApi.permissionBits.label("UpdateRtcRegion")).toBe("Set voice region")
    for (const name of ["NotAPermission", "toString", 7, undefined])
        expect(thrown(() => defaultApi.permissionBits.label(name as never))).toMatchObject({
            _tag: "HelperError",
            operation: "permissionBits.label",
            reason: "permissionBits",
        })
})

test("patchOverwrite changes only the named permissions and keeps every other bit", () => {
    const { Permissions } = defaultApi
    const send = Permissions.SendMessages
    const react = Permissions.AddReactions
    const view = Permissions.ViewChannel
    const unknown = (1n << 62n) | (1n << 63n)
    // A missing overwrite counts as nothing allowed or denied
    expect(defaultApi.permissionBits.patchOverwrite(undefined, { allow: ["SendMessages"] })).toEqual({
        allow: send,
        deny: 0n,
    })
    expect(defaultApi.permissionBits.patchOverwrite(undefined, {})).toEqual({ allow: 0n, deny: 0n })
    const current = { allow: send | view | unknown, deny: react }
    // Allowing clears the deny, denying clears the allow, and inheriting clears both
    expect(defaultApi.permissionBits.patchOverwrite(current, { allow: ["AddReactions"] })).toEqual({
        allow: send | view | react | unknown,
        deny: 0n,
    })
    expect(defaultApi.permissionBits.patchOverwrite(current, { deny: ["SendMessages"] })).toEqual({
        allow: view | unknown,
        deny: react | send,
    })
    expect(
        defaultApi.permissionBits.patchOverwrite(current, { inherit: ["SendMessages", "AddReactions", "ViewChannel"] }),
    ).toEqual({ allow: unknown, deny: 0n })
    // Lists combine, duplicates within a list are harmless, and an empty change returns the same bits
    expect(
        defaultApi.permissionBits.patchOverwrite(current, {
            allow: ["AddReactions", "AddReactions"],
            deny: ["ViewChannel"],
            inherit: ["SendMessages"],
        }),
    ).toEqual({ allow: react | unknown, deny: view })
    expect(defaultApi.permissionBits.patchOverwrite(current, { allow: [], deny: [], inherit: [] })).toEqual(current)
    // The input is not changed, and the result is frozen
    const result = defaultApi.permissionBits.patchOverwrite(current, { deny: ["SendMessages"] })
    expect(current).toEqual({ allow: send | view | unknown, deny: react })
    expect(Object.isFrozen(result)).toBe(true)
    // Extra fields of an overwrite as read are ignored
    expect(
        defaultApi.permissionBits.patchOverwrite({ id: "5", type: "role", allow: 0n, deny: 0n } as never, {
            deny: ["SendMessages"],
        }),
    ).toEqual({ allow: 0n, deny: send })
})

test("patchOverwrite rejects ambiguous or invalid input with a HelperError", () => {
    const patch = defaultApi.permissionBits.patchOverwrite
    const rejected: unknown[][] = [
        // One permission in two lists
        [undefined, { allow: ["SendMessages"], deny: ["SendMessages"] }],
        [undefined, { allow: ["SendMessages"], inherit: ["SendMessages"] }],
        [undefined, { deny: ["SendMessages"], inherit: ["SendMessages"] }],
        // Unknown names and lists, and keys that the change does not have
        [undefined, { allow: ["NotAPermission"] }],
        [undefined, { deny: "SendMessages" }],
        [undefined, { allows: ["SendMessages"] }],
        [undefined, undefined],
        [undefined, null],
        [undefined, [["SendMessages"]]],
        // A current overwrite outside the unsigned 64-bit range or of the wrong type
        [{ allow: -1n, deny: 0n }, {}],
        [{ allow: 0n, deny: 1n << 64n }, {}],
        [{ allow: 1, deny: 0n }, {}],
        [{ allow: 0n }, {}],
        [null, {}],
        ["overwrite", {}],
    ]
    for (const args of rejected)
        expect(thrown(() => (patch as (...values: unknown[]) => unknown)(...args))).toMatchObject({
            _tag: "HelperError",
            operation: "permissionBits.patchOverwrite",
            reason: "permissionBits",
        })
})

test("refusedGrants returns the bits Fluxer's grant rule would refuse for the bot's own bits", () => {
    const { Permissions } = defaultApi
    const tts = Permissions.SendTtsMessages
    const send = Permissions.SendMessages
    const view = Permissions.ViewChannel
    const unknown = 1n << 62n
    const refused = defaultApi.permissionBits.refusedGrants
    // Newly allowing a permission the bot lacks is refused, and holding it is not
    expect(refused(undefined, { allow: tts, deny: 0n }, view)).toBe(tts)
    expect(refused(undefined, { allow: tts, deny: 0n }, view | tts)).toBe(0n)
    // Only the newly allowed bits count, not the ones the overwrite already allowed
    expect(refused({ allow: tts, deny: 0n }, { allow: tts | send, deny: 0n }, view)).toBe(send)
    // Ceasing to deny a permission grants it too, whether it is allowed afterwards or inherited
    expect(refused({ allow: 0n, deny: send }, { allow: 0n, deny: 0n }, view)).toBe(send)
    expect(refused({ allow: 0n, deny: send }, { allow: send, deny: 0n }, view)).toBe(send)
    // Denying or ceasing to allow never grants anything
    expect(refused({ allow: send, deny: 0n }, { allow: 0n, deny: send }, 0n)).toBe(0n)
    expect(refused(undefined, { allow: 0n, deny: send | tts }, 0n)).toBe(0n)
    // A removal stops every deny of the removed overwrite, and removing an overwrite that only allows is free
    expect(refused({ allow: view, deny: send | tts }, undefined, send)).toBe(tts)
    expect(refused({ allow: view, deny: 0n }, undefined, 0n)).toBe(0n)
    expect(refused(undefined, undefined, 0n)).toBe(0n)
    // Bits without a known name count like any other
    expect(refused(undefined, { allow: unknown, deny: 0n }, view)).toBe(unknown)
    // A bot with Administrator is never refused
    expect(refused(undefined, { allow: tts | unknown, deny: 0n }, Permissions.Administrator)).toBe(0n)
    expect(refused({ allow: 0n, deny: send }, undefined, Permissions.Administrator)).toBe(0n)
    // The result is a plain bigint and extra fields of an overwrite as read are ignored
    expect(refused({ id: "5", type: "role", allow: 0n, deny: 0n } as never, { allow: tts, deny: 0n }, 0n)).toBe(tts)
})

test("refusedGrants rejects invalid overwrites and held bits with a HelperError", () => {
    const refused = defaultApi.permissionBits.refusedGrants as (...values: unknown[]) => unknown
    const valid = { allow: 1n, deny: 0n }
    const rejected: unknown[][] = [
        [valid, valid, -1n],
        [valid, valid, 1n << 64n],
        [valid, valid, 1],
        [valid, valid, undefined],
        [{ allow: -1n, deny: 0n }, valid, 0n],
        [valid, { allow: 0n, deny: 1n << 64n }, 0n],
        [{ allow: 1, deny: 0n }, valid, 0n],
        [valid, { allow: 0n }, 0n],
        [null, valid, 0n],
        [valid, "overwrite", 0n],
    ]
    for (const args of rejected)
        expect(thrown(() => refused(...args))).toMatchObject({
            _tag: "HelperError",
            operation: "permissionBits.refusedGrants",
            reason: "permissionBits",
        })
})

test("sameOverwrites compares lists as Fluxer does when it syncs a category's children", () => {
    const { Permissions } = defaultApi
    const same = defaultApi.permissionBits.sameOverwrites
    const role = { id: "10", type: "role", allow: Permissions.ViewChannel, deny: 0n } as const
    const member = { id: "20", type: "member", allow: 0n, deny: Permissions.SendMessages } as const
    expect(same([], [])).toBe(true)
    expect(same([role, member], [role, member])).toBe(true)
    // The order does not matter, and other fields of the entries are ignored
    expect(same([role, member], [member, role])).toBe(true)
    expect(same([role], [{ ...role, extra: true } as never])).toBe(true)
    // A different target, type, allow, deny or size is a different list
    expect(same([role], [])).toBe(false)
    expect(same([role], [role, member])).toBe(false)
    expect(same([role], [{ ...role, id: "11" }])).toBe(false)
    expect(same([role], [{ ...role, type: "member" }])).toBe(false)
    expect(same([role], [{ ...role, allow: 0n }])).toBe(false)
    expect(same([role], [{ ...role, deny: Permissions.SendMessages }])).toBe(false)
    // The inputs are not changed
    const left = [member, role]
    same(left, [role, member])
    expect(left).toEqual([member, role])
})

test("sameOverwrites rejects invalid lists and a list that names a target twice with a HelperError", () => {
    const same = defaultApi.permissionBits.sameOverwrites as (...values: unknown[]) => unknown
    const valid = { id: "10", type: "role", allow: 1n, deny: 0n }
    const rejected: unknown[][] = [
        // Fluxer rejects the same ID twice on write, so neither list may hold it, even with another type
        [[valid, valid], [valid]],
        [[valid], [valid, { ...valid, type: "member" }]],
        [[valid], undefined],
        [undefined, [valid]],
        [[valid], "list"],
        [[valid], [null]],
        [[valid], [{ ...valid, id: "01" }]],
        [[valid], [{ ...valid, id: 10 }]],
        [[valid], [{ ...valid, type: "user" }]],
        [[valid], [{ ...valid, allow: -1n }]],
        [[valid], [{ ...valid, deny: 1n << 64n }]],
        [[valid], [{ ...valid, allow: 1 }]],
    ]
    for (const args of rejected)
        expect(thrown(() => same(...args))).toMatchObject({
            _tag: "HelperError",
            operation: "permissionBits.sameOverwrites",
            reason: "permissionBits",
        })
})

test("applies display, named permissions, decimal serialization, and hosted guild/direct-message link contracts", () => {
    expect(defaultApi.display.name({ username: "user", displayName: "Display" })).toBe("Display")
    expect(defaultApi.display.name({ username: "user", displayName: null }, { nickname: "Guild name" })).toBe(
        "Guild name",
    )
    expect(defaultApi.display.name({ username: "user", displayName: null }, { nickname: null })).toBe("user")
    expect(defaultApi.display.name({ username: "user" })).toBe("user")
    expect(defaultApi.permissionBits.has(defaultApi.Permissions.ManageGuild, "ManageGuild")).toBe(true)
    expect(defaultApi.permissionBits.has(defaultApi.Permissions.ManageGuild, "ManageChannels")).toBe(false)
    expect(defaultApi.permissionBits.toDecimal((1n << 63n) | defaultApi.Permissions.ManageGuild)).toBe(
        "9223372036854775840",
    )
    expect(thrown(() => defaultApi.permissionBits.toDecimal(-1n))).toMatchObject({
        _tag: "HelperError",
        operation: "permissionBits.toDecimal",
        reason: "permissionBits",
    })
    expect(thrown(() => defaultApi.permissionBits.has(0n, "NotAPermission" as never))).toMatchObject({
        operation: "permissionBits.has",
        reason: "permissionBits",
    })

    expect(defaultApi.links.channel(guildChannel)).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}`,
    )
    expect(defaultApi.links.channel(directMessage)).toBe(`https://fluxer.app/channels/@me/${directMessage.id}`)
    expect(defaultApi.links.message(message, guildChannel)).toBe(
        `https://fluxer.app/channels/${guildChannel.guildId}/${guildChannel.id}/${message.id}`,
    )
    expect(
        thrown(() => defaultApi.links.message({ ...message, channelId: directMessage.id }, guildChannel)),
    ).toMatchObject({ operation: "links.message", reason: "link" })
    expect(defaultApi.links.installation(guildChannel.id)).toBe(
        `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot`,
    )
    expect(defaultApi.links.installation(guildChannel.id, { permissions: 0n })).toBe(
        `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=0`,
    )
    expect(defaultApi.links.installation(guildChannel.id, { permissions: 1n << 63n })).toBe(
        `https://api.fluxer.app/v1/oauth2/authorize?client_id=${guildChannel.id}&scope=bot&permissions=9223372036854775808`,
    )
})

test("rejects noncanonical installation IDs and options without alternate hosted routes, scopes, or requests", () => {
    for (const [id, options, reason] of [
        ["01", undefined, "id"],
        [guildChannel.id, { permissions: -1n }, "permissionBits"],
        [guildChannel.id, { permissions: 1n << 64n }, "permissionBits"],
        [guildChannel.id, { scope: "identify" }, "link"],
    ] as const)
        expect(thrown(() => defaultApi.links.installation(id, options as never))).toMatchObject({
            _tag: "HelperError",
            operation: "links.installation",
            reason,
        })
})

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
