import { expect, test } from "vitest"
import { guildEdit } from "../../src/internal/guild-settings.js"
import { memberEditSelf, roleReorder, roleSetHoistPositions } from "../../src/internal/guilds.js"
import { channelCreate, channelEdit, channelReorder } from "../../src/internal/channels.js"
import { directMessageEdit } from "../../src/internal/users.js"
import { InputValidationFailure } from "../../src/input-validation.js"
import { base64Image, base64ImagePayload } from "../../src/internal/decode/primitives.js"
import { modes, setup } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { settle } from "../support/settle.js"

const prefix = "data:image/png;base64,"
/** A valid base64 image data URI with this many payload characters, a multiple of four */
const image = (payload: number) => `${prefix}${"A".repeat(payload)}`
/** The largest payload, in whole base64 groups, whose single-field body stays within the limit */
const largestPayload = (field: string, limit: number) => {
    const overhead = `{"${field}":"${prefix}"}`.length
    return Math.floor((limit - overhead) / 4) * 4
}

// Fluxer's per-route JSON limits (RequestBodyLimitMiddleware.ts:12-28, AssetFormatPolicy.ts:111-143 at 0098958f)
test.each([
    ["community settings", 56_972_632, (bytes: number) => guildEdit("20", { banner: image(bytes) }), "banner"],
    ["member profile", 29_010_604, (bytes: number) => memberEditSelf("20", { banner: image(bytes) }), "banner"],
    ["group DM", 15_029_592, (bytes: number) => directMessageEdit("30", { icon: image(bytes) }), "icon"],
] as const)("a %s edit may use Fluxer's whole body limit of %i bytes", (_name, limit, encode, field) => {
    const fitting = largestPayload(field, limit)
    const accepted = encode(fitting)
    expect(accepted).not.toBeInstanceOf(InputValidationFailure)
    expect(Buffer.byteLength((accepted as { json: string }).json)).toBeGreaterThan(limit - 4)
    const refused = encode(fitting + 4)
    expect(refused).toBeInstanceOf(InputValidationFailure)
    expect((refused as InputValidationFailure).detail).toMatchObject({ path: "input", constraint: "size" })
})

// Fluxer caps these lists at 10,000 entries (packages/schema/src/domains/channel/ChannelRequestSchemas.ts:96-99, 464-476,
// GuildRequestSchemas.ts:376, 385 at 0098958f). 10,000 entries with 19-digit IDs stay far below each route's body
// limit, so the count is the only local check. Fails on the old code, which sent longer lists for Fluxer to refuse
const ids = (count: number) => Array.from({ length: count }, (_, index) => String(10n ** 18n + BigInt(index)))
const overwrites = (count: number) => ids(count).map((id) => ({ id, type: "role" as const, allow: 0n, deny: 0n }))
const positions = (count: number) => ids(count).map((id) => ({ id, position: 1 }))
test.each([
    [
        "channel creation",
        (count: number) => channelCreate("20", { type: 0, name: "general", permissionOverwrites: overwrites(count) }),
        "permissionOverwrites",
    ],
    [
        "channel edit",
        (count: number) => channelEdit("30", { permissionOverwrites: overwrites(count) }),
        "permissionOverwrites",
    ],
    ["channel positions", (count: number) => channelReorder("20", positions(count)), "positions"],
    ["role positions", (count: number) => roleReorder("20", positions(count)), "positions"],
    [
        "role hoist positions",
        (count: number) =>
            roleSetHoistPositions(
                "20",
                ids(count).map((id) => ({ id, hoistPosition: 1 })),
            ),
        "positions",
    ],
] as const)("a %s list may hold Fluxer's 10,000 entries and no more", (_name, encode, path) => {
    expect(encode(10_000)).not.toBeInstanceOf(InputValidationFailure)
    const refused = encode(10_001)
    expect(refused).toBeInstanceOf(InputValidationFailure)
    expect((refused as InputValidationFailure).detail).toMatchObject({ path, constraint: "length" })
    expect((refused as InputValidationFailure).detail.explanation).toContain("at most 10,000")
})

test.each(modes)(
    "%s sends a community settings edit with a 10 MiB image under the default REST options",
    async (mode) => {
        const sizes: number[] = []
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            sizes.push(Buffer.byteLength(String(init.body)))
            return new Response(null, { status: 400 })
        })
        const client = await setup(mode)
        expect(client.diagnostics().rest.queuedJsonByteCapacity).toBe(67_108_864)
        // 10 MiB of image bytes is 13,981,016 base64 characters
        const banner = `${prefix}${"A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3))}`
        await expect(settle(client.guilds.edit("20", { banner }))).rejects.toMatchObject({ reason: "rejected" })
        expect(sizes).toEqual([Buffer.byteLength(JSON.stringify({ banner }))])
    },
)

test("images follow Fluxer's base64 rule, checked in one pass so images of tens of megabytes do not exhaust the stack", () => {
    // Fluxer trims, reads the text after the first comma and detects the format from the bytes
    // (FileValidators.ts:17-47, 80-108 at 0098958f)
    for (const valid of [
        `${prefix}AAAA`,
        `${prefix}AA==`,
        `${prefix}AAA=`,
        `${prefix}AQ==`,
        `${prefix}AAE=`,
        "data:image/svg+xml;charset=utf-8;base64,AA+/",
        "AAAA",
        "iVBORw0KGgo=",
        "data:text/plain;base64,AAAA",
        "data:image/png,AAAA",
        ` ${prefix}AAAA\n`,
        `${prefix}AA\fAA\u202E`,
    ])
        expect(base64Image(valid), valid).toBe(true)
    for (const invalid of [
        prefix,
        "",
        `${prefix}AAA`,
        `${prefix}A===`,
        `${prefix}====`,
        `${prefix}AA=A`,
        `${prefix}AA-_`,
        `${prefix}AA AA`,
        `${prefix}AAAA,AAAA`,
        "https://example.com/image.png",
        42,
    ])
        expect(base64ImagePayload(invalid), String(invalid)).toEqual({ problem: "format" })
    // Nonzero bits before the padding, which Buffer never writes but Fluxer refuses
    for (const padded of [`${prefix}AB==`, `${prefix}AP==`, `${prefix}AAB=`, "AAD="])
        expect(base64ImagePayload(padded), padded).toEqual({ problem: "padding" })
    expect(base64Image(`${prefix}${"A".repeat(40_000_000)}`)).toBe(true)
})

test.each(modes)(
    "%s refuses non-canonical image base64 locally and sends bare base64 as Fluxer accepts it",
    async (mode) => {
        const bodies: string[] = []
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            bodies.push(String(init.body))
            return new Response(null, { status: 400 })
        })
        const client = await setup(mode)
        const icon = Buffer.from("fixture image bytes").toString("base64")
        await expect(settle(client.guilds.edit("20", { icon }))).rejects.toMatchObject({ reason: "rejected" })
        expect(bodies).toEqual([JSON.stringify({ icon })])
        for (const operation of [
            () => client.guilds.edit("20", { icon: `${prefix}AB==` }),
            () => client.members.editSelf("20", { avatar: "AAB=" }),
            () => client.roles.edit({ guildId: "20", id: "30" }, { icon: `${prefix}AB==` }),
            () => client.webhooks.edit("40", { avatar: `${prefix}AB==` }),
            () => client.directMessages.editGroup("50", { icon: "AB==" }),
            () => client.emojis.create("20", { name: "Fixture", image: "AB==" }),
        ])
            await expect(settle(operation() as never)).rejects.toMatchObject({
                reason: "input",
                outcome: "notDispatched",
                message: expect.stringContaining("not canonical base64"),
            })
        expect(bodies).toHaveLength(1)
    },
)

test.each(modes)("%s sends an empty nullable image, which Fluxer reads as null and clears", async (mode) => {
    const bodies: string[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        // The group DM edit reads the channel first, so only write bodies are kept
        if (init.method !== "GET") bodies.push(String(init.body))
        return new Response(null, { status: 400 })
    })
    const client = await setup(mode)
    // These routes read their bodies through Validator('json'), which turns "" into null (Validator.ts:59-63)
    for (const operation of [
        () => client.guilds.edit("20", { icon: "" }),
        () => client.members.editSelf("20", { avatar: "", banner: "" }),
        () => client.roles.edit({ guildId: "20", id: "30" }, { icon: "", unicodeEmoji: "🙂" }),
        () => client.roles.edit({ guildId: "20", id: "30" }, { unicodeEmoji: "", icon: `${prefix}AAAA` }),
        () => client.webhooks.edit("40", { avatar: "" }),
        // Passing local validation, this reads the channel first, which the fixture answers with 400
        () => client.directMessages.editGroup("50", { icon: "" }),
    ])
        await expect(settle(operation() as never)).rejects.toMatchObject({ reason: "rejected" })
    expect(bodies.map((body) => JSON.parse(body))).toEqual([
        { icon: "" },
        { avatar: "", banner: "" },
        expect.objectContaining({ icon: "", unicode_emoji: "🙂" }),
        expect.objectContaining({ icon: `${prefix}AAAA`, unicode_emoji: "" }),
        expect.objectContaining({ avatar: "" }),
    ])
    // An emoji image is required, so Fluxer refuses an empty one
    await expect(settle(client.emojis.create("20", { name: "Fixture", image: "" }) as never)).rejects.toMatchObject({
        reason: "input",
    })
    expect(bodies).toHaveLength(5)
})
