import type {
    GuildEmoji,
    GuildSticker,
    ExpressionMetadata,
    ExpressionReference,
    ExpressionBatch,
    ExpressionDeleteOptions,
} from "#sdk/expressions"
import type { ModerationOptions } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"

export type ExpressionKind = "emojis" | "stickers"
export type ExpressionResources = { emojis: GuildEmoji; stickers: GuildSticker }
export type ExpressionUpdate<K extends ExpressionKind> = Readonly<{
    guildId: string
    items: readonly ExpressionResources[K][]
}>
const text = (value: unknown, min: number, max: number): value is string =>
    typeof value === "string" && [...value].length >= min && [...value].length <= max

export function decodeExpression<K extends ExpressionKind>(
    kind: K,
    value: unknown,
    guildId: string,
): ExpressionResources[K] | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        typeof value.animated !== "boolean"
    )
        return undefined
    const base = { guildId, id: value.id, name: value.name, animated: value.animated }
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

function list<K extends ExpressionKind>(kind: K, value: unknown, guildId: string) {
    if (!Array.isArray(value)) return undefined
    const result: ExpressionResources[K][] = []
    const ids = new Set<string>()
    for (const item of value) {
        const decoded = decodeExpression(kind, item, guildId)
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
    const items = list(kind, value[kind], value.guild_id)
    return items && Object.freeze({ guildId: value.guild_id, items })
}

export function expressionList<K extends ExpressionKind>(
    kind: K,
    guildId: string,
): GuildRequest<readonly ExpressionResources[K][]> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: `guild:${kind}`,
        path: `/guilds/${guildId}/${kind}`,
        method: "GET",
        status: 200,
        cache: { selection: { kind, guildId }, replace: true },
        decode: (value) => list(kind, value, guildId),
    }
}

export function expressionMetadata(kind: ExpressionKind, id: string): GuildRequest<ExpressionMetadata> | undefined {
    if (!identifier(id)) return undefined
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

function encode(kind: ExpressionKind, value: unknown, create: boolean) {
    if (
        !record(value) ||
        Object.keys(value).some(
            (key) =>
                ![
                    "name",
                    ...(create ? ["image"] : []),
                    ...(kind === "stickers" ? ["description", "tags"] : []),
                ].includes(key),
        )
    )
        return undefined
    if (
        kind === "emojis"
            ? !(typeof value.name === "string" && /^[A-Za-z0-9_]{2,32}$/.test(value.name))
            : !text(value.name, 2, 30)
    )
        return undefined
    if (create) {
        if (typeof value.image !== "string" || value.image.length > 699_150) return undefined
        const raw = value.image.replace(/^data:image\/[a-zA-Z0-9.+-]+(?:;[^,;=\s]+=[^,;\s]*)*;base64,/, "")
        if (
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw) ||
            !raw.length ||
            Buffer.byteLength(raw, "base64") > 524_288
        )
            return undefined
    }
    if (kind === "stickers") {
        if (value.description !== undefined && value.description !== null && !text(value.description, 1, 500))
            return undefined
        if (
            value.tags !== undefined &&
            (!Array.isArray(value.tags) ||
                value.tags.length > 10 ||
                !Array.from(value.tags).every((tag) => text(tag, 1, 30)))
        )
            return undefined
    }
    return {
        name: value.name,
        ...(create ? { image: value.image } : {}),
        ...(kind === "stickers" ? { description: value.description ?? null, tags: value.tags ?? [] } : {}),
    }
}

export function expressionCreate<K extends ExpressionKind>(
    kind: K,
    guildId: string,
    input: unknown,
    options?: ModerationOptions,
): GuildRequest<ExpressionResources[K]> | undefined {
    const base = expressionList(kind, guildId)
    const body = encode(kind, input, true)
    const audit = auditSettings(options)
    if (!base || !body || !audit) return undefined
    return {
        ...base,
        ...audit,
        method: "POST",
        json: JSON.stringify(body),
        cache: { selection: { kind, guildId }, mutation: true },
        decode: (value) => decodeExpression(kind, value, guildId),
    }
}

export function expressionClone<K extends ExpressionKind>(
    kind: K,
    guildId: string,
    sourceId: string,
    options?: ModerationOptions,
): GuildRequest<ExpressionResources[K]> | undefined {
    const base = expressionList(kind, guildId)
    const audit = auditSettings(options)
    if (!base || !identifier(sourceId) || !audit) return undefined
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
    guildId: string,
    inputs: unknown,
    options?: ModerationOptions,
): GuildRequest<ExpressionBatch<ExpressionResources[K]>> | undefined {
    const base = expressionList(kind, guildId)
    const audit = auditSettings(options)
    if (!base || !audit || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 50) return undefined
    const items = Array.from(inputs, (item) => encode(kind, item, true))
    const count = inputs.length
    if (items.some((item) => !item)) return undefined
    return {
        ...base,
        ...audit,
        method: "POST",
        path: `${base.path}/bulk`,
        json: JSON.stringify({ [kind]: items }),
        cache: { selection: { kind, guildId }, mutation: true, batch: true },
        decode: (value) => {
            if (!record(value) || !Array.isArray(value.failed)) return undefined
            const success = list(kind, value.success, guildId)
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
                failed: Object.freeze(value.failed.map((item) => Object.freeze({ name: item.name as string }))),
            })
        },
    }
}

export function expressionEdit<K extends ExpressionKind>(
    kind: K,
    target: ExpressionReference,
    input: unknown,
    options?: ModerationOptions,
): GuildRequest<ExpressionResources[K]> | undefined {
    if (!record(target) || !identifier(target.id)) return undefined
    const { id, guildId } = target
    const base = expressionList(kind, target.guildId)
    if (kind === "stickers") {
        if (
            !record(input) ||
            !Object.hasOwn(input, "name") ||
            !Object.hasOwn(input, "description") ||
            !Object.hasOwn(input, "tags")
        )
            return undefined
        if (
            Object.keys(input).some(
                (key) => !["name", "description", "tags", "guildId", "id", "animated"].includes(key),
            )
        )
            return undefined
        if (
            (input.id !== undefined && input.id !== id) ||
            (input.guildId !== undefined && input.guildId !== guildId) ||
            (input.animated !== undefined && typeof input.animated !== "boolean")
        )
            return undefined
        if (input.description === undefined || input.tags === undefined) return undefined
        input = { name: input.name, description: input.description === "" ? null : input.description, tags: input.tags }
    }
    const body = encode(kind, input, false)
    const audit = auditSettings(options)
    if (!base || !body || !audit) return undefined
    return {
        ...base,
        ...audit,
        method: "PATCH",
        path: `${base.path}/${target.id}`,
        json: JSON.stringify(body),
        cache: { selection: { kind, guildId: target.guildId, id: target.id }, mutation: true },
        decode: (value) => {
            const result = decodeExpression(kind, value, guildId)
            return result?.id === id ? result : undefined
        },
    }
}

export function expressionDelete(
    kind: ExpressionKind,
    target: ExpressionReference,
    options?: ExpressionDeleteOptions,
): GuildRequest<void> | undefined {
    if (!record(target) || !identifier(target.id)) return undefined
    const base = expressionList(kind, target.guildId)
    const audit = auditSettings(options)
    if (!base || !audit || (options?.purge !== undefined && typeof options.purge !== "boolean")) return undefined
    return {
        ...base,
        ...audit,
        method: "DELETE",
        path: `${base.path}/${target.id}?purge=${options?.purge === true}`,
        status: 204,
        cache: { selection: { kind, guildId: target.guildId, id: target.id }, mutation: true },
        decode: () => undefined,
    }
}
