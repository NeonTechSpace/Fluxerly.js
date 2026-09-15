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

/** Choose the image file format for an asset URL. Webp is the default, stickers do not accept a format choice */
export const AssetFormats: Readonly<{
    /** Static PNG image, use animated false for an animated source */
    Png: "png"
    /** Static JPEG image, use animated false for an animated source */
    Jpeg: "jpeg"
    /** WebP image, supports static images and animation */
    Webp: "webp"
    /** GIF image, can preserve animation */
    Gif: "gif"
    /** Animated PNG image, can preserve animation */
    Apng: "apng"
}> = Object.freeze({
    Png: "png",
    Jpeg: "jpeg",
    Webp: "webp",
    Gif: "gif",
    Apng: "apng",
})

/** One image encoding the hosted Fluxer media proxy can produce */
export type AssetFormat = (typeof AssetFormats)[keyof typeof AssetFormats]

/** Choose the format, size and animation requested by an asset URL.
 * Unknown keys or invalid values return AssetUrlError. Options are checked even when the target's image is absent
 */
export interface AssetUrlOptions {
    /** Requested image size in pixels, an integer from 0 through 4_294_967_295.
     * Omit it to leave size selection to Fluxer. The helper sends it unchanged, Fluxer selects a supported size for that asset
     */
    readonly size?: number
    /** Output encoding. `Webp` is used when omitted */
    readonly format?: AssetFormat
    /** Request animation or a still image. When omitted, animated asset hashes or emoji metadata select animation.
     * Requesting animation with Png or Jpeg fails locally, choose animated false to request a still image instead
     */
    readonly animated?: boolean
}

/** Choose sticker size and animation. There is no format option because Fluxer chooses the sticker encoding.
 * Unknown keys or invalid values return AssetUrlError
 */
export interface StickerAssetUrlOptions {
    /** Requested size in pixels, an integer from 0 through 4_294_967_295. Omit to leave size selection to Fluxer, the helper does not resize it locally */
    readonly size?: number
    /** Override the sticker's animated metadata. Animated stickers return their GIF source, other stickers return WebP */
    readonly animated?: boolean
}

/** The SDK could not make an asset URL from your input.
 * Read operation to identify the helper and reason to identify the invalid part.
 * Default API helpers return this in a Result, native helpers fail with it when run. It does not store the rejected value
 */
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
    property: "avatar" | "banner",
    operation: AssetOperation,
): Result<Readonly<{ guildId: string; userId: string; asset: AssetHash; profileFlags?: unknown }>, AssetUrlError> {
    const resolved = target(value, operation)
    if (resolved.isErr()) return err(resolved.error)
    const guildId = id(resolved.value.guildId, operation)
    if (guildId.isErr()) return err(guildId.error)
    const userId = id(resolved.value.userId, operation)
    if (userId.isErr()) return err(userId.error)
    const asset = optionalHash(resolved.value[property], operation)
    if (asset.isErr()) return err(asset.error)
    return ok({
        guildId: guildId.value,
        userId: userId.value,
        asset: asset.value,
        ...(operation === "assets.displayMemberAvatar" ? { profileFlags: resolved.value.profileFlags } : {}),
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
 * Make image URLs from user, member, server, emoji or sticker information you already have.
 * Each method returns a Result immediately, with a URL on success or AssetUrlError for invalid input.
 * URLs use the hosted media and static-CDN origins. Making one does not fetch profiles, download an image or verify that it exists.
 * For optional image hashes, undefined stays undefined (the observation did not include it), while null stays null (no image was supplied).
 * These helpers do not transform attachment or embed URLs, refresh expired URLs or change caches
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
export const assets: Readonly<{
    /** Build an account-banner URL directly from a users.fetchProfile observation, reading only user.id and profile.banner.
     * A null banner stays null, including withheld limited-profile data, it does not prove the account has no banner.
     * Uses AssetUrlOptions' WebP default and transform validation, without fetching, selecting a guild banner or verifying existence
     */
    userBanner(
        profile: Readonly<{
            /** Account identity from users.fetchProfile, used to select the banner's owner */
            user: Pick<User, "id">
            /** Observed banner hash, or null when this profile response does not provide one */
            profile: Pick<UserProfileFields, "banner">
        }>,
        options?: AssetUrlOptions,
    ): Result<string | null, AssetUrlError>
    /** Return the user's custom-avatar URL, or null when their avatar field is null.
     * Uses only id and avatar. No profile is fetched. An omitted avatar is invalid
     */
    avatar(user: Pick<User, "id" | "avatar">, options?: AssetUrlOptions): Result<string | null, AssetUrlError>
    /** Build Fluxer's static default-avatar URL from a user ID. Static defaults have no media transform query and do not depend on user-profile availability */
    defaultAvatar(userId: string): Result<string, AssetUrlError>
    /** Return a URL suitable for displaying a user avatar, using their custom avatar or a static default when avatar is null.
     * Requires known user id and avatar fields. It never returns null, invalid targets or options return AssetUrlError
     */
    displayAvatar(user: Pick<User, "id" | "avatar">, options?: AssetUrlOptions): Result<string, AssetUrlError>
    /** Return the member's server-avatar URL using only guildId, userId and avatar.
     * Returns undefined for an omitted avatar hash, or null for an explicitly absent avatar. Use displayMemberAvatar if you want a fallback
     */
    memberAvatar(
        member: Pick<GuildMember, "guildId" | "userId" | "avatar">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Return the member's server-banner URL using only guildId, userId and banner.
     * Returns undefined for an omitted banner hash, or null for an explicitly absent banner. It does not substitute the account banner
     */
    memberBanner(
        member: Pick<GuildMember, "guildId" | "userId" | "banner">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Choose an avatar to display for a user in a server. The user id must match member.userId.
     * Normally chooses the member avatar, then the account avatar, then a static default. AvatarUnset instead selects the static default directly.
     * Returns undefined if profileFlags is omitted or avatar is omitted without AvatarUnset.
     * Reads guildId, userId, avatar and profileFlags from the member. Invalid targets or options return AssetUrlError
     */
    displayMemberAvatar(
        user: Pick<User, "id" | "avatar">,
        member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">,
        options?: AssetUrlOptions,
    ): Result<string | undefined, AssetUrlError>
    /** Return a server-icon URL from the server's id and icon. An omitted icon hash returns undefined, an explicitly absent icon returns null */
    guildIcon(
        guild: Pick<Guild, "id" | "icon">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Return a server-banner URL from the server's id and banner. An omitted banner hash returns undefined, an explicitly absent banner returns null */
    guildBanner(
        guild: Pick<Guild, "id" | "banner">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Return the server's invite-background image URL from id and splash. An omitted splash hash returns undefined, an explicitly absent splash returns null */
    guildSplash(
        guild: Pick<Guild, "id" | "splash">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Return the background image URL for an embedded server invite, using id and embedSplash.
     * An omitted embedSplash hash returns undefined, an explicitly absent one returns null
     */
    guildEmbedSplash(
        guild: Pick<Guild, "id" | "embedSplash">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError>
    /** Return a custom-emoji image URL from its ID and animated metadata, no emoji is looked up.
     * Animated emoji request animation by default. Choose Webp, Gif or Apng to preserve it, or animated false for a still image
     */
    emoji(emoji: Pick<GuildEmoji, "id" | "animated">, options?: AssetUrlOptions): Result<string, AssetUrlError>
    /** Build a custom-sticker URL from only its ID and `animated` metadata. Sticker format is intentionally absent: Fluxer returns WebP except an animated sticker's GIF source */
    sticker(
        sticker: Pick<GuildSticker, "id" | "animated">,
        options?: StickerAssetUrlOptions,
    ): Result<string, AssetUrlError>
}> = Object.freeze({
    userBanner(
        profile: Readonly<{
            user: Pick<User, "id">
            profile: Pick<UserProfileFields, "banner">
        }>,
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
    defaultAvatar(userId: string): Result<string, AssetUrlError> {
        return id(userId, "assets.defaultAvatar").map(staticDefaultAvatar)
    },
    displayAvatar(user: Pick<User, "id" | "avatar">, options?: AssetUrlOptions): Result<string, AssetUrlError> {
        const resolved = userTarget(user, "assets.displayAvatar")
        if (resolved.isErr()) return err(resolved.error)
        return displayUserAvatar(resolved.value, options, "assets.displayAvatar")
    },
    memberAvatar(
        member: Pick<GuildMember, "guildId" | "userId" | "avatar">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = memberTarget(member, "avatar", "assets.memberAvatar")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.userId,
            resolved.value.asset,
            (id, hash, format) => `/guilds/${resolved.value.guildId}/users/${id}/avatars/${hash}.${format}`,
            options,
            "assets.memberAvatar",
        )
    },
    memberBanner(
        member: Pick<GuildMember, "guildId" | "userId" | "banner">,
        options?: AssetUrlOptions,
    ): Result<string | null | undefined, AssetUrlError> {
        const resolved = memberTarget(member, "banner", "assets.memberBanner")
        if (resolved.isErr()) return err(resolved.error)
        return absentOrOwnerAsset(
            resolved.value.userId,
            resolved.value.asset,
            (id, hash, format) => `/guilds/${resolved.value.guildId}/users/${id}/banners/${hash}.${format}`,
            options,
            "assets.memberBanner",
        )
    },
    displayMemberAvatar(
        user: Pick<User, "id" | "avatar">,
        member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">,
        options?: AssetUrlOptions,
    ): Result<string | undefined, AssetUrlError> {
        const resolvedUser = userTarget(user, "assets.displayMemberAvatar")
        if (resolvedUser.isErr()) return err(resolvedUser.error)
        const resolvedMember = memberTarget(member, "avatar", "assets.displayMemberAvatar")
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
        if (resolvedMember.value.asset === undefined)
            return validateImageOptions(options, "assets.displayMemberAvatar").map(() => undefined)
        return resolvedMember.value.asset === null
            ? displayUserAvatar(resolvedUser.value, options, "assets.displayMemberAvatar")
            : ownerAsset(
                  resolvedMember.value.userId,
                  resolvedMember.value.asset,
                  (id, hash, format) => `/guilds/${resolvedMember.value.guildId}/users/${id}/avatars/${hash}.${format}`,
                  options,
                  "assets.displayMemberAvatar",
              )
    },
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
    emoji(emoji: Pick<GuildEmoji, "id" | "animated">, options?: AssetUrlOptions): Result<string, AssetUrlError> {
        const resolved = expressionTarget(emoji, "assets.emoji")
        if (resolved.isErr()) return err(resolved.error)
        return imageOptions(options, "assets.emoji", resolved.value.animated, true).map((assetOptions) =>
            mediaUrl(`/emojis/${resolved.value.id}.${assetOptions.format}`, assetOptions),
        )
    },
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

/**
 * Bind the pure asset helpers to validated instance media and static-CDN bases
 *
 * This keeps the hosted `assets` export stable while preserving its local input
 * validation and result types for a selected instance
 */
export function createInstanceAssets(media: string, staticCdn: string): typeof assets {
    const project = <A extends string | null | undefined>(value: Result<A, AssetUrlError>): Result<A, AssetUrlError> =>
        value.map((url) => {
            if (typeof url !== "string") return url
            if (url.startsWith(mediaOrigin)) return `${media}${url.slice(mediaOrigin.length)}` as A
            if (url.startsWith(staticOrigin)) return `${staticCdn}${url.slice(staticOrigin.length)}` as A
            return url
        })
    return Object.freeze({
        userBanner: (...input: Parameters<typeof assets.userBanner>) => project(assets.userBanner(...input)),
        avatar: (...input: Parameters<typeof assets.avatar>) => project(assets.avatar(...input)),
        defaultAvatar: (...input: Parameters<typeof assets.defaultAvatar>) => project(assets.defaultAvatar(...input)),
        displayAvatar: (...input: Parameters<typeof assets.displayAvatar>) => project(assets.displayAvatar(...input)),
        memberAvatar: (...input: Parameters<typeof assets.memberAvatar>) => project(assets.memberAvatar(...input)),
        memberBanner: (...input: Parameters<typeof assets.memberBanner>) => project(assets.memberBanner(...input)),
        displayMemberAvatar: (...input: Parameters<typeof assets.displayMemberAvatar>) =>
            project(assets.displayMemberAvatar(...input)),
        guildIcon: (...input: Parameters<typeof assets.guildIcon>) => project(assets.guildIcon(...input)),
        guildBanner: (...input: Parameters<typeof assets.guildBanner>) => project(assets.guildBanner(...input)),
        guildSplash: (...input: Parameters<typeof assets.guildSplash>) => project(assets.guildSplash(...input)),
        guildEmbedSplash: (...input: Parameters<typeof assets.guildEmbedSplash>) =>
            project(assets.guildEmbedSplash(...input)),
        emoji: (...input: Parameters<typeof assets.emoji>) => project(assets.emoji(...input)),
        sticker: (...input: Parameters<typeof assets.sticker>) => project(assets.sticker(...input)),
    })
}
