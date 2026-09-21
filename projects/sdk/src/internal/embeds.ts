import type { Embed } from "#sdk/embeds"
import { InputValidationFailure, inputValidationFailure, type InputValidationConstraint } from "#sdk/input-validation"
import { validCalendarTimestamp } from "./timestamp.js"
import { normalizedText } from "./field-text.js"

const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
type Reader = (value: unknown, construct?: boolean) => unknown
type Property = readonly [
    wire: string,
    read: Reader,
    required?: boolean,
    validation?: readonly [constraint: InputValidationConstraint, explanation: string],
]
type Shape = Record<string, Property>
const string: Reader = (value) => (typeof value === "string" ? value : undefined)
const boolean: Reader = (value) => (typeof value === "boolean" ? value : undefined)
const integer: Reader = (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined
const length =
    (min: number, max: number): Reader =>
    (value) =>
        normalizedText(value, min, max) ? value : undefined
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
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const timestamp: Reader = (value) => {
    return typeof value === "string" && isoTimestamp.test(value) && validCalendarTimestamp(value) ? value : undefined
}

// The tables own only response projection, which ignores unknown wire properties
function project(value: unknown, shape: Shape, construct = true): Record<string, unknown> | true | undefined {
    if (!object(value)) return undefined
    const result: Record<string, unknown> | undefined = construct ? {} : undefined
    for (const [key, [wire, read, required]] of Object.entries(shape)) {
        const item = value[wire]
        if (item === undefined || item === null) {
            if (required) return undefined
            continue
        }
        const decoded = read(item, construct)
        if (decoded === undefined) return undefined
        if (result) result[key] = decoded
    }
    return result ? Object.freeze(result) : true
}

function projectInput(value: unknown, shape: Shape, path: string): Record<string, unknown> | InputValidationFailure {
    if (!object(value)) return inputValidationFailure(path, "type", "Embed components must be objects")
    if (Object.keys(value).some((key) => !Object.hasOwn(shape, key)))
        return inputValidationFailure(path, "allowedFields", "Embed component contains an unsupported field")
    const result: Record<string, unknown> = {}
    for (const [key, [wire, read, required, validation]] of Object.entries(shape)) {
        const item = value[key]
        if (item === undefined) {
            if (required)
                return inputValidationFailure(
                    `${path}.${key}`,
                    "required",
                    validation?.[1] ?? "Required embed field is missing",
                )
            continue
        }
        const decoded = read(item)
        if (decoded instanceof InputValidationFailure) return decoded
        if (decoded === undefined)
            return inputValidationFailure(
                `${path}.${key}`,
                validation?.[0] ?? "format",
                validation?.[1] ?? "Embed field has an invalid format",
            )
        result[wire] = decoded
    }
    return Object.freeze(result)
}

function list(value: unknown, read: Reader, max = Infinity, construct = true): readonly unknown[] | true | undefined {
    if (!Array.isArray(value)) return undefined
    const count = value.length
    if (count > max) return undefined
    const result: unknown[] | undefined = construct ? [] : undefined
    for (let index = 0; index < count; index += 1) {
        const item = value[index]
        const decoded = read(item, construct)
        if (decoded === undefined) return undefined
        result?.push(decoded)
    }
    return result ? Object.freeze(result) : true
}

function inputList(
    value: unknown,
    read: Reader,
    maximum: number,
    path: string,
): readonly unknown[] | InputValidationFailure {
    if (!Array.isArray(value)) return inputValidationFailure(path, "type", "Embed collection must be an array")
    const count = value.length
    if (count > maximum)
        return inputValidationFailure(path, "length", `Embed collection may contain at most ${maximum} entries`)
    const result: unknown[] = []
    for (let index = 0; index < count; index += 1) {
        const item = value[index]
        const decoded = read(item)
        if (decoded instanceof InputValidationFailure) return decoded
        if (decoded === undefined) return inputValidationFailure(`${path}[]`, "format", "Embed entry is invalid")
        result.push(decoded)
    }
    return Object.freeze(result)
}

const inputAuthor: Shape = {
    name: [
        "name",
        length(1, 256),
        true,
        ["length", "Embed author name must contain 1 through 256 UTF-16 code units after provider normalization"],
    ],
    url: ["url", url, false, ["format", "Embed author URL must be an HTTP URL up to 2,048 characters"]],
    iconUrl: ["icon_url", url, false, ["format", "Embed author iconUrl must be an HTTP URL up to 2,048 characters"]],
}
const inputFooter: Shape = {
    text: [
        "text",
        length(1, 2048),
        true,
        ["length", "Embed footer text must contain 1 through 2,048 UTF-16 code units after provider normalization"],
    ],
    iconUrl: ["icon_url", url, false, ["format", "Embed footer iconUrl must be an HTTP URL up to 2,048 characters"]],
}
const inputMedia = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    url: [
        "url",
        (value) => attachmentUrl(value, uploadedFilenames),
        true,
        ["format", "Embed media URL must be HTTP or an unambiguous supported attachment URL"],
    ],
    description: [
        "description",
        length(1, 4096),
        false,
        [
            "length",
            "Embed media description must contain 1 through 4,096 UTF-16 code units after provider normalization",
        ],
    ],
})
const inputField: Shape = {
    name: [
        "name",
        length(1, 256),
        true,
        ["length", "Embed field name must contain 1 through 256 UTF-16 code units after provider normalization"],
    ],
    value: [
        "value",
        length(0, 1024),
        true,
        ["length", "Embed field value must contain at most 1,024 UTF-16 code units after provider normalization"],
    ],
    inline: ["inline", boolean, false, ["type", "Embed field inline must be a boolean"]],
}
const inputEmbed = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    title: [
        "title",
        length(0, 256),
        false,
        ["length", "Embed title must contain at most 256 UTF-16 code units after provider normalization"],
    ],
    description: [
        "description",
        (value) => (value === "" ? value : length(1, 4096)(value)),
        false,
        [
            "length",
            "Embed description must be empty or contain 1 through 4,096 UTF-16 code units after provider normalization",
        ],
    ],
    url: ["url", url, false, ["format", "Embed URL must be an HTTP URL up to 2,048 characters"]],
    color: [
        "color",
        (value) => (integer(value) !== undefined && (value as number) <= 0xffffff ? value : undefined),
        false,
        ["range", "Embed color must be an integer from 0 through 16,777,215"],
    ],
    timestamp: [
        "timestamp",
        timestamp,
        false,
        ["format", "Embed timestamp must be an ISO 8601 timestamp with timezone"],
    ],
    author: ["author", (value) => projectInput(value, inputAuthor, "embeds[].author")],
    footer: ["footer", (value) => projectInput(value, inputFooter, "embeds[].footer")],
    image: ["image", (value) => projectInput(value, inputMedia(uploadedFilenames), "embeds[].image")],
    thumbnail: ["thumbnail", (value) => projectInput(value, inputMedia(uploadedFilenames), "embeds[].thumbnail")],
    fields: [
        "fields",
        (value) =>
            inputList(value, (field) => projectInput(field, inputField, "embeds[].fields[]"), 25, "embeds[].fields"),
    ],
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
    author: ["author", (value, construct) => project(value, outputAuthor, construct)],
    footer: ["footer", (value, construct) => project(value, outputFooter, construct)],
    image: ["image", (value, construct) => project(value, outputMedia, construct)],
    thumbnail: ["thumbnail", (value, construct) => project(value, outputMedia, construct)],
    fields: [
        "fields",
        (value, construct) => list(value, (field, build) => project(field, outputField, build), Infinity, construct),
    ],
    provider: ["provider", (value, construct) => project(value, outputAuthor, construct)],
    video: ["video", (value, construct) => project(value, outputMedia, construct)],
    audio: ["audio", (value, construct) => project(value, outputMedia, construct)],
    html: ["html", string],
    htmlWidth: ["html_width", integer],
    htmlHeight: ["html_height", integer],
    nsfw: ["nsfw", boolean],
}
const outputEmbed: Shape = {
    ...outputChild,
    children: [
        "children",
        (value, construct) => list(value, (child, build) => project(child, outputChild, build), 1, construct),
    ],
}

/** attachment:// media targets need an unambiguous new upload in this request. Retained IDs never imply a filename lookup */
export const encodeEmbeds = (value: unknown, uploadedFilenames?: readonly string[]) =>
    inputList(value, (embed) => projectInput(embed, inputEmbed(uploadedFilenames), "embeds[]"), Infinity, "embeds")

export function decodeEmbeds(value: unknown): readonly Embed[] | undefined
export function decodeEmbeds(value: unknown, construct: boolean): readonly Embed[] | true | undefined
/** False validates the same response shape without constructing a projection. The value true is the validation-only success marker */
export function decodeEmbeds(value: unknown, construct = true): readonly Embed[] | true | undefined {
    if (value === undefined || value === null) return construct ? Object.freeze([]) : true
    // Each public property is checked and copied by the response tables, with no input objects retained
    return list(value, (embed, build) => project(embed, outputEmbed, build), Infinity, construct) as
        readonly Embed[] | true | undefined
}
