import { afterEach, expect, test, vi } from "vitest"
import * as native from "../../../src/effect.js"
import * as defaultApi from "../../../src/index.js"

const userId = "1750000000000000000"
const guildId = "1750000000000000001"
const memberId = "1750000000000000002"
const expressionId = "1750000000000000003"

afterEach(() => vi.unstubAllGlobals())

/** Return the AssetUrlError an asset helper throws for invalid input. Returning normally fails the test */
function thrown(run: () => unknown): unknown {
    try {
        run()
    } catch (error) {
        expect(error).toBeInstanceOf(defaultApi.AssetUrlError)
        return error
    }
    throw Error("Expected the asset helper to throw AssetUrlError")
}

test("builds every hosted asset route through both public entries without fetching", () => {
    let fetches = 0
    vi.stubGlobal("fetch", () => {
        fetches += 1
        throw Error("Asset helpers must not fetch")
    })
    const user = { id: userId, avatar: "avatar_hash" }
    const member = { guildId, userId, avatar: "member_hash", banner: "member_banner", profileFlags: 0 }
    const guild = {
        id: guildId,
        icon: "icon_hash",
        banner: "banner_hash",
        splash: "splash_hash",
        embedSplash: "embed_hash",
    }
    const animatedEmoji = { id: expressionId, animated: true }
    const animatedSticker = { id: expressionId, animated: true }

    expect(defaultApi.assets.avatar(user, { size: 256, format: defaultApi.AssetFormats.Webp })).toBe(
        `https://fluxerusercontent.com/avatars/${userId}/avatar_hash.webp?size=256`,
    )
    expect(defaultApi.assets.defaultAvatar(userId)).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(defaultApi.assets.displayAvatar({ id: userId, avatar: null })).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(defaultApi.assets.memberAvatar(member, { format: defaultApi.AssetFormats.Png })).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.png`,
    )
    expect(defaultApi.assets.memberBanner(member, { size: 480 })).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/banners/member_banner.webp?size=480`,
    )
    expect(defaultApi.assets.displayMemberAvatar(user, member)).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(defaultApi.assets.guildIcon(guild)).toBe(`https://fluxerusercontent.com/icons/${guildId}/icon_hash.webp`)
    expect(defaultApi.assets.guildBanner(guild)).toBe(
        `https://fluxerusercontent.com/banners/${guildId}/banner_hash.webp`,
    )
    expect(defaultApi.assets.guildSplash(guild)).toBe(
        `https://fluxerusercontent.com/splashes/${guildId}/splash_hash.webp`,
    )
    expect(defaultApi.assets.guildEmbedSplash(guild)).toBe(
        `https://fluxerusercontent.com/embed-splashes/${guildId}/embed_hash.webp`,
    )
    expect(defaultApi.assets.emoji(animatedEmoji, { size: 512, format: defaultApi.AssetFormats.Gif })).toBe(
        `https://fluxerusercontent.com/emojis/${expressionId}.gif?size=512&animated=true`,
    )
    expect(defaultApi.assets.sticker(animatedSticker, { size: 128 })).toBe(
        `https://fluxerusercontent.com/stickers/${expressionId}.webp?size=128&animated=true`,
    )

    expect(native.assets.avatar(user, { size: 256, format: native.AssetFormats.Webp })).toBe(
        `https://fluxerusercontent.com/avatars/${userId}/avatar_hash.webp?size=256`,
    )
    expect(native.assets.defaultAvatar(userId)).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(native.assets.displayAvatar({ id: userId, avatar: null })).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(native.assets.memberAvatar(member)).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(native.assets.memberBanner(member)).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/banners/member_banner.webp`,
    )
    expect(native.assets.displayMemberAvatar(user, member)).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(native.assets.guildIcon(guild)).toBe(`https://fluxerusercontent.com/icons/${guildId}/icon_hash.webp`)
    expect(native.assets.guildBanner(guild)).toBe(`https://fluxerusercontent.com/banners/${guildId}/banner_hash.webp`)
    expect(native.assets.guildSplash(guild)).toBe(`https://fluxerusercontent.com/splashes/${guildId}/splash_hash.webp`)
    expect(native.assets.guildEmbedSplash(guild)).toBe(
        `https://fluxerusercontent.com/embed-splashes/${guildId}/embed_hash.webp`,
    )
    expect(native.assets.emoji(animatedEmoji, { format: native.AssetFormats.Apng })).toBe(
        `https://fluxerusercontent.com/emojis/${expressionId}.apng?animated=true`,
    )
    expect(native.assets.sticker(animatedSticker)).toBe(
        `https://fluxerusercontent.com/stickers/${expressionId}.webp?animated=true`,
    )
    expect(fetches).toBe(0)
})

test("preserves missing versus unknown assets and uses only known display-avatar fallbacks", () => {
    const userWithoutAvatar = { id: userId, avatar: null }

    expect(defaultApi.assets.avatar(userWithoutAvatar)).toBeNull()
    expect(defaultApi.assets.memberAvatar({ guildId, userId })).toBeUndefined()
    expect(defaultApi.assets.memberAvatar({ guildId, userId, avatar: null })).toBeNull()
    expect(defaultApi.assets.memberBanner({ guildId, userId })).toBeUndefined()
    expect(defaultApi.assets.guildIcon({ id: guildId })).toBeUndefined()
    expect(defaultApi.assets.guildBanner({ id: guildId, banner: null })).toBeNull()
    expect(
        defaultApi.assets.displayMemberAvatar(userWithoutAvatar, {
            guildId,
            userId,
            avatar: null,
            profileFlags: 0,
        }),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(
        defaultApi.assets.displayMemberAvatar(
            { id: userId, avatar: "global_hash" },
            {
                guildId,
                userId,
                avatar: "member_hash",
                profileFlags: defaultApi.GuildMemberProfileFlags.AvatarUnset,
            },
        ),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(
        defaultApi.assets.displayMemberAvatar(
            { id: userId, avatar: "global_hash" },
            { guildId, userId, profileFlags: defaultApi.GuildMemberProfileFlags.AvatarUnset },
        ),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(defaultApi.assets.displayMemberAvatar(userWithoutAvatar, { guildId, userId, avatar: null })).toBeUndefined()
    expect(
        defaultApi.assets.displayMemberAvatar(userWithoutAvatar, { guildId, userId, profileFlags: 0 }),
    ).toBeUndefined()
})

test("member asset helpers inspect only their selected public input fields", () => {
    const avatarMember = {
        guildId,
        userId,
        avatar: "a_member_hash",
        banner: "bad-banner",
        get profileFlags(): never {
            throw Error("Direct member assets must not read profile flags")
        },
    }
    const bannerMember = {
        guildId,
        userId,
        avatar: "bad-avatar",
        banner: "a_member_banner",
        get profileFlags(): never {
            throw Error("Direct member assets must not read profile flags")
        },
    }
    const avatarUrl = `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/a_member_hash.webp`
    const bannerUrl = `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/banners/a_member_banner.webp`
    expect(defaultApi.assets.memberAvatar(avatarMember)).toBe(avatarUrl)
    expect(native.assets.memberAvatar(avatarMember)).toBe(avatarUrl)
    expect(defaultApi.assets.memberBanner(bannerMember)).toBe(bannerUrl)
    expect(native.assets.memberBanner(bannerMember)).toBe(bannerUrl)

    const displayMember = { guildId, userId, avatar: "a_member_hash", banner: "bad-banner", profileFlags: 0 }
    const user = { id: userId, avatar: null }
    expect(defaultApi.assets.displayMemberAvatar(user, displayMember)).toBe(avatarUrl)
    expect(native.assets.displayMemberAvatar(user, displayMember)).toBe(avatarUrl)
    for (const selected of [undefined, null, "bad-hash"]) {
        const avatar = {
            guildId,
            userId,
            banner: "bad-banner",
            ...(selected === undefined ? {} : { avatar: selected }),
        }
        const banner = {
            guildId,
            userId,
            avatar: "bad-avatar",
            ...(selected === undefined ? {} : { banner: selected }),
        }
        for (const api of [defaultApi, native]) {
            if (typeof selected === "string") {
                expect(thrown(() => api.assets.memberAvatar(avatar))).toMatchObject({ reason: "hash" })
                expect(thrown(() => api.assets.memberBanner(banner))).toMatchObject({ reason: "hash" })
            } else {
                expect(api.assets.memberAvatar(avatar)).toBe(selected)
                expect(api.assets.memberBanner(banner)).toBe(selected)
            }
        }
    }
    expect(
        thrown(() => defaultApi.assets.memberAvatar(avatarMember, { format: defaultApi.AssetFormats.Png })),
    ).toMatchObject({ reason: "options" })
    expect(
        thrown(() => defaultApi.assets.memberBanner(bannerMember, { format: defaultApi.AssetFormats.Png })),
    ).toMatchObject({ reason: "options" })
})

test("throws AssetUrlError for invalid targets and unsafe animation requests in both entries", () => {
    expect(thrown(() => defaultApi.assets.avatar({ id: "01", avatar: "avatar_hash" }))).toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.avatar",
        reason: "id",
    })

    expect(thrown(() => defaultApi.assets.avatar({ id: userId, avatar: "bad-hash" }))).toMatchObject({
        reason: "hash",
    })
    expect(thrown(() => defaultApi.assets.avatar({ id: userId, avatar: "a_" }))).toMatchObject({ reason: "hash" })
    const arbitraryOrigin = { origin: "https://untrusted.example" }
    expect(
        thrown(() =>
            // @ts-expect-error Asset URL helpers have no caller-provided origin option.
            defaultApi.assets.avatar({ id: userId, avatar: "avatar_hash" }, arbitraryOrigin),
        ),
    ).toMatchObject({ reason: "options" })
    expect(thrown(() => defaultApi.assets.displayAvatar({ id: userId, avatar: null }, { size: -1 }))).toMatchObject({
        reason: "options",
    })
    expect(
        thrown(() =>
            defaultApi.assets.guildIcon({ id: guildId }, { format: defaultApi.AssetFormats.Png, animated: true }),
        ),
    ).toMatchObject({ reason: "options" })
    expect(
        defaultApi.assets.avatar(
            { id: userId, avatar: "a_animated" },
            { format: defaultApi.AssetFormats.Png, animated: false },
        ),
    ).toBe(`https://fluxerusercontent.com/avatars/${userId}/a_animated.png?animated=false`)
    expect(
        thrown(() =>
            defaultApi.assets.avatar({ id: userId, avatar: "a_animated" }, { format: defaultApi.AssetFormats.Png }),
        ),
    ).toMatchObject({ reason: "options" })
    expect(
        thrown(() => defaultApi.assets.avatar({ id: userId, avatar: "avatar_hash" }, { size: 4_294_967_296 })),
    ).toMatchObject({ reason: "options" })
    expect(
        thrown(() =>
            defaultApi.assets.emoji({ id: expressionId, animated: true }, { format: defaultApi.AssetFormats.Jpeg }),
        ),
    ).toMatchObject({ reason: "options" })
    expect(
        thrown(() =>
            defaultApi.assets.sticker({ id: expressionId, animated: false }, {
                format: defaultApi.AssetFormats.Webp,
            } as never),
        ),
    ).toMatchObject({ reason: "options" })
    expect(
        thrown(() =>
            defaultApi.assets.displayMemberAvatar(
                { id: userId, avatar: null },
                { guildId, userId: memberId, avatar: null, profileFlags: 0 },
            ),
        ),
    ).toMatchObject({ reason: "target" })
    expect(
        thrown(() =>
            defaultApi.assets.displayMemberAvatar(
                { id: userId, avatar: "a_animated" },
                { guildId, userId, avatar: null, profileFlags: 0 },
                { format: defaultApi.AssetFormats.Png },
            ),
        ),
    ).toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.displayMemberAvatar",
        reason: "options",
    })

    expect(thrown(() => native.assets.avatar({ id: "01", avatar: "avatar_hash" }))).toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.avatar",
        reason: "id",
    })
    expect(
        thrown(() => native.assets.emoji({ id: expressionId, animated: true }, { format: native.AssetFormats.Png })),
    ).toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.emoji",
        reason: "options",
    })
    expect(
        thrown(() =>
            native.assets.displayAvatar({ id: userId, avatar: null }, { origin: "https://untrusted.example" } as never),
        ),
    ).toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.displayAvatar",
        reason: "options",
    })
})
