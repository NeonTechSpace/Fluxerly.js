/**
 * Emoji and sticker operations and gateway expression updates.
 * Invariant: An expression update is a changed collection, never an initial list or cache refill, and it invalidates the cache first.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type {
    GuildEmoji,
    GuildSticker,
    ExpressionMetadata,
    ExpressionReference,
    ExpressionBatch,
    ExpressionDeleteOptions,
    ExpressionSourceGuild,
} from "#sdk/expressions"
import type { GuildRequest } from "./guilds.js"
import {
    base64ImageExplanation,
    base64ImagePayload,
    identifier,
    inputId,
    record,
    snapshotArray,
} from "./decode/primitives.js"
import { rejectCheck } from "./decode/trace.js"
import { auditSettings } from "./moderation.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { normalizedText as text, normalizeText } from "./field-text.js"
import { defaultBodyLimit, expressionBatchBodyLimit } from "./request-body-limits.js"
import type { AuditedRequestOptions } from "#sdk/client"

export type ExpressionKind = "emojis" | "stickers"
export type ExpressionResources = { emojis: GuildEmoji; stickers: GuildSticker }
export type ExpressionUpdate<K extends ExpressionKind> = Readonly<{
    guildId: string
    items: readonly ExpressionResources[K][]
}>

function decodeExpression<K extends ExpressionKind>(
    kind: K,
    value: unknown,
    guildId: string,
    creators = false,
): ExpressionResources[K] | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        typeof value.animated !== "boolean"
    )
        return undefined
    // Only list reads include the uploader, as a partial user
    const creatorId = creators && record(value.user) && identifier(value.user.id) ? value.user.id : undefined
    const base = {
        guildId,
        id: value.id,
        name: value.name,
        animated: value.animated,
        ...(creatorId === undefined ? {} : { creatorId }),
    }
    if (kind === "emojis") return Object.freeze(base) as ExpressionResources[K]
    if (
        typeof value.description !== "string" ||
        !Array.isArray(value.tags) ||
        value.tags.length > 10 ||
        !value.tags.every((tag) => typeof tag === "string")
    )
        return undefined
    return Object.freeze({
        ...base,
        description: value.description,
        tags: Object.freeze([...value.tags]),
    }) as ExpressionResources[K]
}

/** Decode a complete guild expression collection, or undefined when any item is malformed or repeated. Creators are
 * kept only for a list read, the one source that sends them
 */
export function expressionItems<K extends ExpressionKind>(kind: K, value: unknown, guildId: string, creators = false) {
    if (!Array.isArray(value)) return undefined
    const result: ExpressionResources[K][] = []
    const ids = new Set<string>()
    for (const item of value) {
        const decoded = decodeExpression(kind, item, guildId, creators)
        if (!decoded || ids.has(decoded.id)) return undefined
        ids.add(decoded.id)
        result.push(decoded)
    }
    return Object.freeze(result)
}

/** Projects a full provider expression-update collection without retaining wire-only fields */
export function decodeExpressionUpdate<K extends ExpressionKind>(
    kind: K,
    value: unknown,
): ExpressionUpdate<K> | undefined {
    if (!record(value) || !identifier(value.guild_id)) return undefined
    const items = expressionItems(kind, value[kind], value.guild_id)
    return items && Object.freeze({ guildId: value.guild_id, items })
}

export function expressionList<K extends ExpressionKind>(
    kind: K,
    rawGuildId: string,
): GuildRequest<readonly ExpressionResources[K][]> | InputValidationFailure {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId,
        bucket: `guild:${kind}`,
        path: `/guilds/${guildId}/${kind}`,
        method: "GET",
        status: 200,
        cache: { selection: { kind, guildId }, replace: true },
        decode: (value) => expressionItems(kind, value, guildId, true),
    }
}

export function expressionMetadata(
    kind: ExpressionKind,
    rawId: string,
): GuildRequest<ExpressionMetadata> | InputValidationFailure {
    const id = inputId(rawId)
    if (id === undefined)
        return inputValidationFailure(
            "expressionId",
            "format",
            "Expression IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId: id,
        bucket: `${kind}:metadata`,
        path: `/${kind}/${id}/metadata`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (
                !record(value) ||
                !identifier(value.guild_id) ||
                value.id !== id ||
                typeof value.allow_cloning !== "boolean"
            )
                return undefined
            const base = decodeExpression("emojis", value, value.guild_id)
            return base && Object.freeze({ ...base, allowCloning: value.allow_cloning })
        },
    }
}

function expressionFields(kind: ExpressionKind, create: boolean): readonly string[] {
    return ["name", ...(create ? ["image"] : []), ...(kind === "stickers" ? ["description", "tags"] : [])]
}

const emojiName = (value: string): boolean => /^[A-Za-z0-9_]{2,32}$/.test(normalizeText(value))

function encode(kind: ExpressionKind, value: unknown, create: boolean, prefix = "") {
    const path = (field: string) => (prefix ? `${prefix}.${field}` : field)
    if (!record(value)) return inputValidationFailure(prefix || "input", "type", "Expression input must be an object")
    const accepted = expressionFields(kind, create)
    const unsupported = unsupportedKeyFailure(
        value,
        accepted,
        prefix || "input",
        `the ${kind === "emojis" ? "emoji" : "sticker"} input`,
    )
    if (unsupported) return unsupported
    // Fluxer measures and tests the normalized name, so the raw name may carry surrounding whitespace, form feeds or
    // U+202E (packages/schema/src/domains/guild/GuildRequestSchemas.ts:226-228 with
    // packages/schema/src/primitives/SchemaPrimitives.ts:20-22 and :176-183 at 0098958f). The raw name is sent as given
    if (kind === "emojis" && !(typeof value.name === "string" && emojiName(value.name)))
        return inputValidationFailure(
            path("name"),
            "format",
            "Emoji name must contain 2 through 32 ASCII letters, digits, or underscores after Fluxer's normalization",
        )
    if (kind === "stickers" && !text(value.name, 2, 30))
        return inputValidationFailure(
            path("name"),
            "length",
            "Sticker name must contain 2 through 30 UTF-16 code units after Fluxer's normalization",
        )
    if (create) {
        // Fluxer reads the base64 text of the image as for every image. Its decoded size limit comes from each
        // community's emoji_max_size or sticker_max_size, which an instance may raise to 100 MiB, so only Fluxer checks
        // it (fluxer_api/src/api/infrastructure/AvatarService.ts:111-136 and :214-220 and ImageUploadValidation.ts:30-55,
        // with the 100 MiB ceiling in the constants package's LimitConfigMetadata.ts:348-368, at 0098958f). The SDK
        // copies no rule from that limit configuration, so the release drift check does not need to watch it
        const image = value.image
        const checked = base64ImagePayload(image)
        if (!("payload" in checked))
            return inputValidationFailure(
                path("image"),
                "format",
                base64ImageExplanation("Expression image", image, false),
            )
    }
    let tags: readonly string[] | undefined
    if (kind === "stickers") {
        // Sticker routes read their body through Fluxer's Validator, which turns an empty description into null
        // (fluxer_api/src/api/Validator.ts:59-63 at 0098958f), so it is sent as null
        if (
            value.description !== undefined &&
            value.description !== null &&
            value.description !== "" &&
            !text(value.description, 1, 500)
        )
            return inputValidationFailure(
                path("description"),
                "length",
                "Sticker description must be null, empty or contain 1 through 500 UTF-16 code units after Fluxer's normalization",
            )
        const rawTags = value.tags
        const snapshot = rawTags === undefined ? undefined : snapshotArray(rawTags, 10)
        if (rawTags !== undefined && (!snapshot || !snapshot.every((tag) => text(tag, 1, 30))))
            return inputValidationFailure(
                path("tags[]"),
                "format",
                "Sticker tags must contain at most ten entries of 1 through 30 UTF-16 code units after Fluxer's normalization",
            )
        tags = snapshot as readonly string[] | undefined
    }
    return {
        name: value.name,
        ...(create ? { image: value.image } : {}),
        ...(kind === "stickers"
            ? { description: value.description === "" ? null : (value.description ?? null), tags: tags ?? [] }
            : {}),
    }
}

export function expressionCreate<K extends ExpressionKind>(
    kind: K,
    rawGuildId: string,
    input: unknown,
    options?: AuditedRequestOptions,
): GuildRequest<ExpressionResources[K]> | InputValidationFailure {
    const base = expressionList(kind, rawGuildId)
    const body = encode(kind, input, true)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    const guildId = base.guildId
    if (body instanceof InputValidationFailure) return body
    if (audit instanceof InputValidationFailure) return audit
    const json = JSON.stringify(body)
    if (Buffer.byteLength(json) > defaultBodyLimit)
        return inputValidationFailure(
            "input",
            "size",
            "Expression input must not exceed 15,029,592 encoded bytes, the most Fluxer accepts",
        )
    return {
        ...base,
        ...audit,
        method: "POST",
        json,
        cache: { selection: { kind, guildId }, mutation: true },
        decode: (value) => decodeExpression(kind, value, guildId),
    }
}

export function expressionClone<K extends ExpressionKind>(
    kind: K,
    rawGuildId: string,
    rawSourceId: string,
    options?: AuditedRequestOptions,
): GuildRequest<ExpressionResources[K]> | InputValidationFailure {
    const base = expressionList(kind, rawGuildId)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    const guildId = base.guildId
    const sourceId = inputId(rawSourceId)
    if (sourceId === undefined)
        return inputValidationFailure(
            "sourceId",
            "format",
            "Source expression IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (audit instanceof InputValidationFailure) return audit
    return {
        ...base,
        ...audit,
        method: "POST",
        path: `${base.path}/clone`,
        json: JSON.stringify({ [kind === "emojis" ? "source_emoji_id" : "source_sticker_id"]: sourceId }),
        cache: { selection: { kind, guildId }, mutation: true },
        decode: (value) => decodeExpression(kind, value, guildId),
    }
}

export function expressionBatch<K extends ExpressionKind>(
    kind: K,
    rawGuildId: string,
    inputs: unknown,
    options?: AuditedRequestOptions,
): GuildRequest<ExpressionBatch<ExpressionResources[K]>> | InputValidationFailure {
    const base = expressionList(kind, rawGuildId)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    const guildId = base.guildId
    if (audit instanceof InputValidationFailure) return audit
    const itemsInput = snapshotArray(inputs, 50)
    if (!itemsInput && !Array.isArray(inputs))
        return inputValidationFailure("inputs", "type", "Expression batch input must be an array")
    if (!itemsInput || itemsInput.length < 1)
        return inputValidationFailure("inputs", "length", "Expression batch input must contain 1 through 50 entries")
    const items = itemsInput.map((item) => encode(kind, item, true, "inputs[]"))
    const count = itemsInput.length
    const failed = items.find((item): item is InputValidationFailure => item instanceof InputValidationFailure)
    if (failed) return failed
    const json = JSON.stringify({ [kind]: items })
    if (Buffer.byteLength(json) > expressionBatchBodyLimit)
        return inputValidationFailure(
            "inputs",
            "size",
            "Expression batch input must not exceed 36,001,112 encoded bytes, the most Fluxer accepts",
        )
    return {
        ...base,
        ...audit,
        method: "POST",
        path: `${base.path}/bulk`,
        json,
        cache: { selection: { kind, guildId }, mutation: true, batch: true },
        decode: (value) => {
            if (!record(value) || !Array.isArray(value.failed)) return undefined
            const success = expressionItems(kind, value.success, guildId)
            if (
                !success ||
                value.failed.some(
                    (item) => !record(item) || typeof item.name !== "string" || typeof item.error !== "string",
                )
            )
                return undefined
            if (success.length + value.failed.length !== count) return undefined
            return Object.freeze({
                success,
                failed: Object.freeze(
                    value.failed.map((item) =>
                        Object.freeze({ name: item.name as string, providerMessage: item.error as string }),
                    ),
                ),
            })
        },
    }
}

export function expressionEdit<K extends ExpressionKind>(
    kind: K,
    target: ExpressionReference,
    input: unknown,
    options?: AuditedRequestOptions,
): GuildRequest<ExpressionResources[K]> | InputValidationFailure {
    if (!record(target)) return inputValidationFailure("target", "type", "Expression targets must be objects")
    const id = inputId(target.id)
    if (id === undefined)
        return inputValidationFailure(
            "target.id",
            "format",
            "Expression IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const base = expressionList(kind, target.guildId)
    const guildId = inputId(target.guildId)
    if (kind === "stickers") {
        if (
            !record(input) ||
            !Object.hasOwn(input, "name") ||
            !Object.hasOwn(input, "description") ||
            !Object.hasOwn(input, "tags")
        )
            return inputValidationFailure("input", "required", "Sticker edit requires name, description, and tags")
        const unsupported = unsupportedKeyFailure(
            input,
            ["name", "description", "tags", "guildId", "id", "animated", "creatorId"],
            "input",
            "the sticker edit",
        )
        if (unsupported) return unsupported
        if (
            (input.id !== undefined && inputId(input.id) !== id) ||
            (input.guildId !== undefined && inputId(input.guildId) !== guildId) ||
            (input.animated !== undefined && typeof input.animated !== "boolean")
        )
            return inputValidationFailure(
                "input",
                "relationship",
                "Sticker snapshot fields must match the selected target",
            )
        if (input.description === undefined || input.tags === undefined)
            return inputValidationFailure("input", "required", "Sticker edit requires description and tags")
        input = { name: input.name, description: input.description === "" ? null : input.description, tags: input.tags }
    }
    const body = encode(kind, input, false)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    if (body instanceof InputValidationFailure) return body
    if (audit instanceof InputValidationFailure) return audit
    const targetGuildId = base.guildId
    return {
        ...base,
        ...audit,
        method: "PATCH",
        path: `${base.path}/${id}`,
        json: JSON.stringify(body),
        cache: { selection: { kind, guildId: targetGuildId, id }, mutation: true },
        decode: (value) => {
            const result = decodeExpression(kind, value, targetGuildId)
            return result === undefined || result.id === id ? result : rejectCheck("targetMismatch")
        },
    }
}

export function expressionDelete(
    kind: ExpressionKind,
    target: ExpressionReference,
    options?: ExpressionDeleteOptions,
): GuildRequest<void> | InputValidationFailure {
    if (!record(target)) return inputValidationFailure("target", "type", "Expression targets must be objects")
    const id = inputId(target.id)
    if (id === undefined)
        return inputValidationFailure(
            "target.id",
            "format",
            "Expression IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const base = expressionList(kind, target.guildId)
    const audit = auditSettings(options)
    if (base instanceof InputValidationFailure) return base
    if (audit instanceof InputValidationFailure) return audit
    if (options?.purge !== undefined && typeof options.purge !== "boolean")
        return inputValidationFailure("options.purge", "type", "Expression purge must be a boolean")
    return {
        ...base,
        ...audit,
        method: "DELETE",
        path: `${base.path}/${id}?purge=${options?.purge === true}`,
        status: 204,
        cache: { selection: { kind, guildId: base.guildId, id }, mutation: true },
        decode: () => undefined,
    }
}

/** Upper bound for a source guild's badge list. Fluxer currently sends at most three badges */
const maximumSourceFeatures = 64

/** Reads the public presentation of an expression's source guild. Every documented field is required. The response
 * carries nothing that ties it to the requested expression, so only its shape is checked. Unrecognized badge strings are
 * retained unchanged, so a badge added by Fluxer does not fail the read, while a non-string entry is malformed
 */
export function expressionSource(
    kind: ExpressionKind,
    rawId: string,
): GuildRequest<ExpressionSourceGuild> | InputValidationFailure {
    const id = inputId(rawId)
    if (id === undefined)
        return inputValidationFailure(
            "expressionId",
            "format",
            "Expression IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        guildId: id,
        bucket: `${kind}:source`,
        path: `/${kind}/${id}/source`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (
                !record(value) ||
                !identifier(value.id) ||
                typeof value.name !== "string" ||
                (value.icon !== null && typeof value.icon !== "string")
            )
                return undefined
            const features = snapshotArray(value.features, maximumSourceFeatures)
            if (!features?.every((feature) => typeof feature === "string")) return undefined
            return Object.freeze({
                id: value.id,
                name: value.name,
                icon: value.icon,
                features: features as readonly string[],
            })
        },
    }
}
