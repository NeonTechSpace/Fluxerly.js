import type { Embed } from "#sdk/embeds"

const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
type Reader = (value: unknown) => unknown
type Property = readonly [wire: string, read: Reader, required?: boolean]
type Shape = Record<string, Property>
const string: Reader = (value) => (typeof value === "string" ? value : undefined)
const boolean: Reader = (value) => (typeof value === "boolean" ? value : undefined)
const integer: Reader = (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined
const length =
    (min: number, max: number): Reader =>
    (value) =>
        typeof value === "string" && value.length >= min && value.length <= max ? value : undefined
const url: Reader = (value) => {
    if (typeof value !== "string" || value.length > 2048) return undefined
    try {
        const parsed = new URL(value)
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined
    } catch {
        return undefined
    }
}
const attachmentUrl = (value: unknown, uploadedFilenames: readonly string[] | undefined): string | undefined => {
    if (typeof value !== "string" || value.length < 1 || value.length > 2048) return undefined
    if (!value.startsWith("attachment://")) return url(value) as string | undefined
    const filename = value.slice("attachment://".length)
    const extension = filename.split(".").pop()?.toLowerCase()
    const matches = uploadedFilenames?.filter((uploaded) => uploaded === filename).length ?? 0
    return /^[\p{L}\p{N}\p{M}_.-]+$/u.test(filename) &&
        matches === 1 &&
        extension !== undefined &&
        ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
        ? value
        : undefined
}
const timestamp: Reader = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
        ? value
        : undefined

// The tables own only embed projection. Input is strict; responses ignore unknown wire properties
function project(value: unknown, shape: Shape, input: boolean): Record<string, unknown> | undefined {
    if (!object(value) || (input && Object.keys(value).some((key) => !Object.hasOwn(shape, key)))) return undefined
    const result: Record<string, unknown> = {}
    for (const [key, [wire, read, required]] of Object.entries(shape)) {
        const item = value[input ? key : wire]
        if (item === undefined || (!input && item === null)) {
            if (required) return undefined
            continue
        }
        const decoded = read(item)
        if (decoded === undefined) return undefined
        result[input ? wire : key] = decoded
    }
    return Object.freeze(result)
}

function list(value: unknown, read: Reader, max = Infinity): readonly unknown[] | undefined {
    if (!Array.isArray(value) || value.length > max) return undefined
    const result: unknown[] = []
    for (const item of value) {
        const decoded = read(item)
        if (decoded === undefined) return undefined
        result.push(decoded)
    }
    return Object.freeze(result)
}

const inputAuthor: Shape = {
    name: ["name", length(1, 256), true],
    url: ["url", url],
    iconUrl: ["icon_url", url],
}
const inputFooter: Shape = {
    text: ["text", length(1, 2048), true],
    iconUrl: ["icon_url", url],
}
const inputMedia = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    url: ["url", (value) => attachmentUrl(value, uploadedFilenames), true],
    description: ["description", length(1, 4096)],
})
const inputField: Shape = {
    name: ["name", length(1, 256), true],
    value: ["value", length(0, 1024), true],
    inline: ["inline", boolean],
}
const inputEmbed = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    title: ["title", length(0, 256)],
    description: ["description", length(0, 4096)],
    url: ["url", url],
    color: ["color", (value) => (integer(value) !== undefined && (value as number) <= 0xffffff ? value : undefined)],
    timestamp: ["timestamp", timestamp],
    author: ["author", (value) => project(value, inputAuthor, true)],
    footer: ["footer", (value) => project(value, inputFooter, true)],
    image: ["image", (value) => project(value, inputMedia(uploadedFilenames), true)],
    thumbnail: ["thumbnail", (value) => project(value, inputMedia(uploadedFilenames), true)],
    fields: ["fields", (value) => list(value, (field) => project(field, inputField, true), 25)],
})

const outputAuthor: Shape = {
    name: ["name", string, true],
    url: ["url", string],
    iconUrl: ["icon_url", string],
    proxyIconUrl: ["proxy_icon_url", string],
}
const outputFooter: Shape = {
    text: ["text", string, true],
    iconUrl: ["icon_url", string],
    proxyIconUrl: ["proxy_icon_url", string],
}
const outputMedia: Shape = {
    url: ["url", string, true],
    proxyUrl: ["proxy_url", string],
    contentType: ["content_type", string],
    contentHash: ["content_hash", string],
    width: ["width", integer],
    height: ["height", integer],
    description: ["description", string],
    placeholder: ["placeholder", string],
    duration: ["duration", integer],
    flags: ["flags", integer, true],
}
const outputField: Shape = {
    name: ["name", string, true],
    value: ["value", string, true],
    inline: ["inline", boolean, true],
}
const outputChild: Shape = {
    type: ["type", string, true],
    title: ["title", string],
    description: ["description", string],
    url: ["url", string],
    color: ["color", integer],
    timestamp: ["timestamp", timestamp],
    author: ["author", (value) => project(value, outputAuthor, false)],
    footer: ["footer", (value) => project(value, outputFooter, false)],
    image: ["image", (value) => project(value, outputMedia, false)],
    thumbnail: ["thumbnail", (value) => project(value, outputMedia, false)],
    fields: ["fields", (value) => list(value, (field) => project(field, outputField, false))],
    provider: ["provider", (value) => project(value, outputAuthor, false)],
    video: ["video", (value) => project(value, outputMedia, false)],
    audio: ["audio", (value) => project(value, outputMedia, false)],
    html: ["html", string],
    htmlWidth: ["html_width", integer],
    htmlHeight: ["html_height", integer],
    nsfw: ["nsfw", boolean],
}
const outputEmbed: Shape = {
    ...outputChild,
    children: ["children", (value) => list(value, (child) => project(child, outputChild, false), 1)],
}

/** attachment:// media targets need an unambiguous new upload in this request. Retained IDs never imply a filename lookup */
export const encodeEmbeds = (value: unknown, uploadedFilenames?: readonly string[]) =>
    list(value, (embed) => project(embed, inputEmbed(uploadedFilenames), true))

export function decodeEmbeds(value: unknown): readonly Embed[] | undefined {
    if (value === undefined || value === null) return Object.freeze([])
    // Each public property is checked and copied by the response tables, with no input objects retained
    return list(value, (embed) => project(embed, outputEmbed, false)) as readonly Embed[] | undefined
}
