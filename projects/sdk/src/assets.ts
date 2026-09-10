import { err, ok, type Result } from "neverthrow"
import { GuildMemberProfileFlags } from "./guilds.js"
import type { Guild, GuildMember } from "./guilds.js"
import { snowflakes } from "./helpers.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { User, UserProfileFields } from "./users.js"

const mediaOrigin = "https://fluxerusercontent.com"
const staticOrigin = "https://fluxerstatic.com"
const largestSize = 4_294_967_295
const hashPattern = /^[A-Za-z0-9_]+$/u

/** Image encodings the hosted Fluxer media proxy can produce for avatar, member, guild, and emoji assets */
export const AssetFormats = Object.freeze({
    Png: "png",
    Jpeg: "jpeg",
    Webp: "webp",
    Gif: "gif",
    Apng: "apng",
})

/** One image encoding the hosted Fluxer media proxy can produce */
export type AssetFormat = (typeof AssetFormats)[keyof typeof AssetFormats]

/** Optional hosted-media transform controls. Unknown keys fail locally; `size` is sent unchanged as Fluxer's unsigned-32-bit request and the provider selects its documented size class */
export interface AssetUrlOptions {
    /** Unsigned 32-bit requested size. Fluxer snaps and clamps it for the asset class; this helper does not silently change it */
    readonly size?: number
    /** Output encoding. `Webp` is used when omitted */
    readonly format?: AssetFormat
    /** Override Fluxer's animation choice. Animated images require `Webp`, `Gif`, or `Apng` to retain animation */
    readonly animated?: boolean
}

/** Optional hosted-media controls for a sticker. Unknown keys fail locally; Fluxer ignores a sticker format request, so stickers intentionally expose no `format` option */
export interface StickerAssetUrlOptions {
    /** Unsigned 32-bit requested size. Fluxer snaps and clamps it for the sticker class; this helper does not silently change it */
    readonly size?: number
    /** Override the expression metadata's animation choice. Animated stickers return their GIF source; other stickers return WebP */
    readonly animated?: boolean
}

/** Locally invalid hosted-asset helper input, without retaining or exposing the rejected value */
export class AssetUrlError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "AssetUrlError"

    constructor(
        /** Asset helper that rejected the input */
        readonly operation:
            | "assets.avatar"
            | "assets.userBanner"
            | "assets.defaultAvatar"
            | "assets.displayAvatar"
            | "assets.memberAvatar"
            | "assets.memberBanner"
            | "assets.displayMemberAvatar"
            | "assets.guildIcon"
            | "assets.guildBanner"
            | "assets.guildSplash"
            | "assets.guildEmbedSplash"
            | "assets.emoji"
            | "assets.sticker",
        /** Whether the structural target, decimal ID, asset hash, or transform options were invalid */
        readonly reason: "target" | "id" | "hash" | "options",
    ) {
        super(`Invalid input for ${operation}`)
        this.name = this._tag
    }
}

type AssetOperation = AssetUrlError["operation"]
type AssetHash = string | null | undefined
type AssetOptions = Readonly<{
    size?: number
    format: AssetFormat
    animated?: boolean
}>

function assetError(operation: AssetOperation, reason: AssetUrlError["reason"]): AssetUrlError {
    return new AssetUrlError(operation, reason)
}

function target(value: unknown, operation: AssetOperation): Result<Record<string, unknown>, AssetUrlError> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? ok(value as Record<string, unknown>)
        : err(assetError(operation, "target"))
}

function id(value: unknown, operation: AssetOperation): Result<string, AssetUrlError> {
    return snowflakes.isValid(value) ? ok(value) : err(assetError(operation, "id"))
}

function hash(value: unknown, operation: AssetOperation): Result<string, AssetUrlError> {
    return typeof value === "string" && value !== "a_" && hashPattern.test(value)
        ? ok(value)
        : err(assetError(operation, "hash"))
}

function optionalHash(value: unknown, operation: AssetOperation): Result<AssetHash, AssetUrlError> {
    if (value === undefined || value === null) return ok(value)
    return hash(value, operation)
}

function userTarget(
    value: unknown,
    operation: AssetOperation,
): Result<Readonly<{ id: string; avatar: string | null }>, AssetUrlError> {
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(resolved.error)
    const userId = id(resolved.value.id, operation)
    if (userId.isErr()) return err(userId.error)
    if (resolved.value.avatar === null) return ok({ id: userId.value, avatar: null })
    return hash(resolved.value.avatar, operation).map((avatar) => ({ id: userId.value, avatar }))
}

function memberTarget(
    value: unknown,
    operation: AssetOperation,
): Result<
    Readonly<{ guildId: string; userId: string; avatar: AssetHash; banner: AssetHash; profileFlags: unknown }>,
    AssetUrlError
> {
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(resolved.error)
    const guildId = id(resolved.value.guildId, operation)
    if (guildId.isErr()) return err(guildId.error)
    const userId = id(resolved.value.userId, operation)
    if (userId.isErr()) return err(userId.error)
    const avatar = optionalHash(resolved.value.avatar, operation)
    if (avatar.isErr()) return err(avatar.error)
    const banner = optionalHash(resolved.value.banner, operation)
    if (banner.isErr()) return err(banner.error)
    return ok({
        guildId: guildId.value,
        userId: userId.value,
        avatar: avatar.value,
        banner: banner.value,
        profileFlags: resolved.value.profileFlags,
    })
}

function guildTarget(
    value: unknown,
    property: "icon" | "banner" | "splash" | "embedSplash",
    operation: AssetOperation,
): Result<Readonly<{ id: string; asset: AssetHash }>, AssetUrlError> {
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(resolved.error)
    const guildId = id(resolved.value.id, operation)
    if (guildId.isErr()) return err(guildId.error)
    return optionalHash(resolved.value[property], operation).map((asset) => ({ id: guildId.value, asset }))
}

function expressionTarget(
    value: unknown,
    operation: "assets.emoji" | "assets.sticker",
): Result<Readonly<{ id: string; animated: boolean }>, AssetUrlError> {
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(resolved.error)
    const expressionId = id(resolved.value.id, operation)
    if (expressionId.isErr()) return err(expressionId.error)
    return typeof resolved.value.animated === "boolean"
        ? ok({ id: expressionId.value, animated: resolved.value.animated })
        : err(assetError(operation, "target"))
}

function imageOptions(
    value: unknown,
    operation: AssetOperation,
    defaultAnimated: boolean | undefined,
    includeDefaultAnimated: boolean,
): Result<AssetOptions, AssetUrlError> {
    if (value === undefined)
        return ok({
            format: AssetFormats.Webp,
            ...(includeDefaultAnimated && defaultAnimated ? { animated: true } : {}),
        })
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(assetError(operation, "options"))
    if (!Object.keys(resolved.value).every((key) => key === "size" || key === "format" || key === "animated"))
        return err(assetError(operation, "options"))

    const inputSize = resolved.value.size
    if (
        inputSize !== undefined &&
        (typeof inputSize !== "number" || !Number.isInteger(inputSize) || inputSize < 0 || inputSize > largestSize)
    )
        return err(assetError(operation, "options"))
    const size = typeof inputSize === "number" ? inputSize : undefined
    const inputFormat = resolved.value.format
    if (
        inputFormat !== undefined &&
        (typeof inputFormat !== "string" || !Object.values(AssetFormats).includes(inputFormat as AssetFormat))
    )
        return err(assetError(operation, "options"))
    const format: AssetFormat = typeof inputFormat === "string" ? (inputFormat as AssetFormat) : AssetFormats.Webp
    const inputAnimated = resolved.value.animated
    if (inputAnimated !== undefined && typeof inputAnimated !== "boolean") return err(assetError(operation, "options"))
    const animated = typeof inputAnimated === "boolean" ? inputAnimated : undefined

    const effectiveAnimated = animated ?? defaultAnimated
    if (effectiveAnimated === true && (format === AssetFormats.Png || format === AssetFormats.Jpeg))
        return err(assetError(operation, "options"))
    return ok({
        ...(size === undefined ? {} : { size }),
        format,
        ...(animated === undefined
            ? includeDefaultAnimated && defaultAnimated === true
                ? { animated: true }
                : {}
            : { animated }),
    })
}

function stickerOptions(
    value: unknown,
    operation: "assets.sticker",
    defaultAnimated: boolean,
): Result<Omit<AssetOptions, "format">, AssetUrlError> {
    if (value === undefined) return ok(defaultAnimated ? { animated: true } : {})
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(assetError(operation, "options"))
    if (!Object.keys(resolved.value).every((key) => key === "size" || key === "animated"))
        return err(assetError(operation, "options"))

    const inputSize = resolved.value.size
    if (
        inputSize !== undefined &&
        (typeof inputSize !== "number" || !Number.isInteger(inputSize) || inputSize < 0 || inputSize > largestSize)
    )
        return err(assetError(operation, "options"))
    const size = typeof inputSize === "number" ? inputSize : undefined
    const inputAnimated = resolved.value.animated
    if (inputAnimated !== undefined && typeof inputAnimated !== "boolean") return err(assetError(operation, "options"))
    const animated = typeof inputAnimated === "boolean" ? inputAnimated : undefined
    return ok({
        ...(size === undefined ? {} : { size }),
        ...(animated === undefined ? (defaultAnimated ? { animated: true } : {}) : { animated }),
    })
}

function mediaUrl(path: string, options: Omit<AssetOptions, "format">): string {
    const query = new URLSearchParams()
    if (options.size !== undefined) query.set("size", String(options.size))
    if (options.animated !== undefined) query.set("animated", String(options.animated))
    const suffix = query.size === 0 ? "" : `?${query}`
    return `${mediaOrigin}${path}${suffix}`
}

function ownerAsset(
    ownerId: string,
    assetHash: string,
    path: (id: string, hash: string, format: AssetFormat) => string,
    options: AssetUrlOptions | undefined,
    operation: AssetOperation,
): Result<string, AssetUrlError> {
    return imageOptions(options, operation, assetHash.startsWith("a_"), false).map((resolved) =>
        mediaUrl(path(ownerId, assetHash, resolved.format), resolved),
    )
}

function staticDefaultAvatar(userId: string): string {
    return `${staticOrigin}/avatars/${BigInt(userId) % 6n}.png`
}

function validateImageOptions(
    options: AssetUrlOptions | undefined,
    operation: AssetOperation,
): Result<void, AssetUrlError> {
    return imageOptions(options, operation, undefined, false).map(() => undefined)
}

function displayUserAvatar(
    user: Readonly<{ id: string; avatar: string | null }>,
    options: AssetUrlOptions | undefined,
    operation: "assets.displayAvatar" | "assets.displayMemberAvatar",
): Result<string, AssetUrlError> {
    return user.avatar === null
        ? validateImageOptions(options, operation).map(() => staticDefaultAvatar(user.id))
        : ownerAsset(user.id, user.avatar, (id, hash, format) => `/avatars/${id}/${hash}.${format}`, options, operation)
}

function absentOrOwnerAsset(
    ownerId: string,
    assetHash: AssetHash,
    path: (id: string, hash: string, format: AssetFormat) => string,
    options: AssetUrlOptions | undefined,
    operation: AssetOperation,
): Result<string | null | undefined, AssetUrlError> {
    return assetHash === undefined
        ? validateImageOptions(options, operation).map(() => undefined)
        : assetHash === null
          ? validateImageOptions(options, operation).map(() => null)
          : ownerAsset(ownerId, assetHash, path, options, operation)
}

function memberProfileFlags(
    value: unknown,
    operation: "assets.displayMemberAvatar",
): Result<number | null | undefined, AssetUrlError> {
    if (value === undefined || value === null) return ok(value)
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
        ? ok(value)
        : err(assetError(operation, "target"))
}

/**
 * Pure hosted Fluxer asset URL helpers. They use the published media and static-CDN origins only; they never fetch profiles,
 * change caches, download bytes, refresh a URL, or transform an attachment/embed URL. Omitted optional hashes return `undefined`
 * (provider state unknown); `null` returns `null` (provider state known to be absent)
 *
 * @example
 * ```ts
 * import { assets, AssetFormats, type Guild, type GuildEmoji, type GuildMember, type User, type UserProfile } from "@neontechspace/fluxerly"
 *
 * export function assetsExample(user: Pick<User, "id" | "avatar">, member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">, guild: Pick<Guild, "id" | "icon">, emoji: Pick<GuildEmoji, "id" | "animated">, profile: UserProfile) {
 *     const avatar = assets.displayAvatar(user, { size: 256, format: AssetFormats.Webp })
 *     const memberAvatar = assets.displayMemberAvatar(user, member, { size: 256 })
 *     const icon = assets.guildIcon(guild, { format: AssetFormats.Png })
 *     const emojiUrl = assets.emoji(emoji, { animated: emoji.animated })
 *     const banner = assets.userBanner(profile)
 *     return { avatar, memberAvatar, icon, emojiUrl, banner }
 * }
 * ```
 */
export const assets = Object.freeze({
    /** Build an account-banner URL directly from a users.fetchProfile observation, reading only user.id and profile.banner.
     * A null banner stays null, including withheld limited-profile data; it does not prove the account has no banner.
     * Uses AssetUrlOptions' WebP default and transform validation, without fetching, selecting a guild banner or verifying existence
     */
    userBanner(
        profile: Readonly<{ user: Pick<User, "id">; profile: Pick<UserProfileFields, "banner"> }>,
        options?: AssetUrlOptions,
    ): Result<string | null, AssetUrlError> {
        const operation = "assets.userBanner"
        const resolved = target(profile, operation)
        if (resolved.isErr()) return err(resolved.error)
        const user = target(resolved.value.user, operation)
        if (user.isErr()) return err(user.error)
        const userId = id(user.value.id, operation)
        if (userId.isErr()) return err(userId.error)
        const fields = target(resolved.value.profile, operation)
        if (fields.isErr()) return err(fields.error)
        if (fields.value.banner === null) return validateImageOptions(options, operation).map(() => null)
        return hash(fields.value.banner, operation).andThen((banner) =>
            ownerAsset(
                userId.value,
                banner,
                (id, hash, format) => `/banners/${id}/${hash}.${format}`,
                options,
                operation,
            ),
        )
    },
    /** Build a user avatar URL, or `null` when this known user has no avatar. The user target contains only `id` and `avatar`; no profile lookup occurs */
    avatar(user: Pick<User, "id" | "avatar">, options?: AssetUrlOptions): Result<string | null, AssetUrlError> {
        const resolved = userTarget(user, "assets.avatar")
        if (resolved.isErr()) return err(resolved.error)
        return resolved.value.avatar === null
            ? validateImageOptions(options, "assets.avatar").map(() => null)
            : ownerAsset(
                  resolved.value.id,
                  resolved.value.avatar,
                  (id, hash, format) => `/avatars/${id}/${hash}.${format}`,
                  options,
                  "assets.avatar",
              )
    },
    /** Build Fluxer's static default-avatar URL from a user ID. Static defaults have no media transform query and do not depend on user-profile availability */
    defaultAvatar(userId: string): Result<string, AssetUrlError> {
        return id(userId, "assets.defaultAvatar").map(staticDefaultAvatar)
    },
    /** Build a display avatar: a known custom avatar when present, otherwise Fluxer's static default avatar. It cannot return `null` */
    displayAvatar(user: Pick<User, "id" | "avatar">, options?: AssetUrlOptions): Result<string, AssetUrlError> {
        const resolved = userTarget(user, "assets.displayAvatar")
        if (resolved.isErr()) return err(resolved.error)
        return displayUserAvatar(resolved.value, options, "assets.displayAvatar")
    },
    /** Build a guild-member avatar URL. `undefined` preserves an omitted member avatar hash; `null` preserves a known absent member avatar. This does not choose a fallback */
    memberAvatar(
        member: Pick<GuildMember, "guildId" | "userId" | "avatar">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = memberTarget(member, "assets.memberAvatar")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.userId,
            resolved.value.avatar,
            (id, hash, format) => `/guilds/${resolved.value.guildId}/users/${id}/avatars/${hash}.${format}`,
            options,
            "assets.memberAvatar",
        )
    },
    /** Build a guild-member banner URL. `undefined` preserves an omitted member banner hash; `null` preserves a known absent member banner */
    memberBanner(
        member: Pick<GuildMember, "guildId" | "userId" | "banner">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = memberTarget(member, "assets.memberBanner")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.userId,
            resolved.value.banner,
            (id, hash, format) => `/guilds/${resolved.value.guildId}/users/${id}/banners/${hash}.${format}`,
            options,
            "assets.memberBanner",
        )
    },
    /** Build the member display avatar when member profile state is known: member avatar, then user avatar, then static default. `AvatarUnset` selects the static default; omitted profile flags or an omitted non-unset member avatar return `undefined` */
    displayMemberAvatar(
        user: Pick<User, "id" | "avatar">,
        member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">,
        options?: AssetUrlOptions,
    ): Result<string | undefined, AssetUrlError> {
        const resolvedUser = userTarget(user, "assets.displayMemberAvatar")
        if (resolvedUser.isErr()) return err(resolvedUser.error)
        const resolvedMember = memberTarget(member, "assets.displayMemberAvatar")
        if (resolvedMember.isErr()) return err(resolvedMember.error)
        if (resolvedUser.value.id !== resolvedMember.value.userId)
            return err(assetError("assets.displayMemberAvatar", "target"))
        const profileFlags = memberProfileFlags(resolvedMember.value.profileFlags, "assets.displayMemberAvatar")
        if (profileFlags.isErr()) return err(profileFlags.error)
        if (profileFlags.value === undefined)
            return validateImageOptions(options, "assets.displayMemberAvatar").map(() => undefined)
        if (profileFlags.value !== null && (profileFlags.value & GuildMemberProfileFlags.AvatarUnset) !== 0)
            return validateImageOptions(options, "assets.displayMemberAvatar").map(() =>
                staticDefaultAvatar(resolvedUser.value.id),
            )
        if (resolvedMember.value.avatar === undefined)
            return validateImageOptions(options, "assets.displayMemberAvatar").map(() => undefined)
        return resolvedMember.value.avatar === null
            ? displayUserAvatar(resolvedUser.value, options, "assets.displayMemberAvatar")
            : ownerAsset(
                  resolvedMember.value.userId,
                  resolvedMember.value.avatar,
                  (id, hash, format) => `/guilds/${resolvedMember.value.guildId}/users/${id}/avatars/${hash}.${format}`,
                  options,
                  "assets.displayMemberAvatar",
              )
    },
    /** Build a guild icon URL. `undefined` preserves an omitted icon hash; `null` preserves a known absent icon */
    guildIcon(
        guild: Pick<Guild, "id" | "icon">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = guildTarget(guild, "icon", "assets.guildIcon")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.id,
            resolved.value.asset,
            (id, hash, format) => `/icons/${id}/${hash}.${format}`,
            options,
            "assets.guildIcon",
        )
    },
    /** Build a guild banner URL. `undefined` preserves an omitted banner hash; `null` preserves a known absent banner */
    guildBanner(
        guild: Pick<Guild, "id" | "banner">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = guildTarget(guild, "banner", "assets.guildBanner")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.id,
            resolved.value.asset,
            (id, hash, format) => `/banners/${id}/${hash}.${format}`,
            options,
            "assets.guildBanner",
        )
    },
    /** Build a guild invite-splash URL. `undefined` preserves an omitted splash hash; `null` preserves a known absent splash */
    guildSplash(
        guild: Pick<Guild, "id" | "splash">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = guildTarget(guild, "splash", "assets.guildSplash")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.id,
            resolved.value.asset,
            (id, hash, format) => `/splashes/${id}/${hash}.${format}`,
            options,
            "assets.guildSplash",
        )
    },
    /** Build a guild embedded-invite-splash URL. `undefined` preserves an omitted embed-splash hash; `null` preserves a known absent splash */
    guildEmbedSplash(
        guild: Pick<Guild, "id" | "embedSplash">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = guildTarget(guild, "embedSplash", "assets.guildEmbedSplash")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.id,
            resolved.value.asset,
            (id, hash, format) => `/embed-splashes/${id}/${hash}.${format}`,
            options,
            "assets.guildEmbedSplash",
        )
    },
    /** Build a custom-emoji URL from only its ID and `animated` metadata. Animated emoji default to `animated=true`; choose WebP, GIF, or APNG to retain animation */
    emoji(emoji: Pick<GuildEmoji, "id" | "animated">, options?: AssetUrlOptions): Result<string, AssetUrlError> {
        const resolved = expressionTarget(emoji, "assets.emoji")
        if (resolved.isErr()) return err(resolved.error)
        return imageOptions(options, "assets.emoji", resolved.value.animated, true).map((assetOptions) =>
            mediaUrl(`/emojis/${resolved.value.id}.${assetOptions.format}`, assetOptions),
        )
    },
    /** Build a custom-sticker URL from only its ID and `animated` metadata. Sticker format is intentionally absent: Fluxer returns WebP except an animated sticker's GIF source */
    sticker(
        sticker: Pick<GuildSticker, "id" | "animated">,
        options?: StickerAssetUrlOptions,
    ): Result<string, AssetUrlError> {
        const resolved = expressionTarget(sticker, "assets.sticker")
        if (resolved.isErr()) return err(resolved.error)
        return stickerOptions(options, "assets.sticker", resolved.value.animated).map((assetOptions) =>
            mediaUrl(`/stickers/${resolved.value.id}.webp`, assetOptions),
        )
    },
})
