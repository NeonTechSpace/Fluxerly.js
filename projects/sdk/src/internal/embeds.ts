/**
 * Embed encoding and projection.
 * Invariant: Input tables validate every supported field, and response projection ignores unknown wire properties.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import type { Embed } from "#sdk/embeds"
import {
    InputValidationFailure,
    inputValidationFailure,
    unsupportedKeyFailure,
    type InputValidationConstraint,
} from "#sdk/input-validation"
import { timestamp as isoTimestamp } from "./decode/timestamp.js"
import { normalizedText } from "./field-text.js"
import { count, record as object } from "./decode/primitives.js"

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
const integer: Reader = (value) => (count(value) ? value : undefined)
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
        // allow-silent: An unparsable URL is rejected as invalid embed input
        return undefined
    }
}
// Fluxer's MessageHelpers.getContentType uses mime 4.1.0 standard and other image/video mappings,
// with ContentTypeUtils overriding .ts to text/plain. Starred MIME aliases do not resolve extensions
const attachmentMediaExtensions: ReadonlySet<string> = Object.freeze(
    new Set(
        (
            "3ds 3g2 3gp 3gpp apng asf asx avci avcs avi avif azv b16 bmp btf btif cgm cmx dds dib djv djvu dng dpx drle " +
            "dvb dwg dxf emf exr f4v facti fbs fh fh4 fh5 fh7 fhc fits fli flv fpx fst fvt g3 gif h261 h263 h264 heic heics " +
            "heif heifs hej2 ico ief jaii jais jfif jhc jls jng jp2 jpe jpeg jpf jpg jpg2 jpgm jpgv jph jpm jpx jxl jxr jxra " +
            "jxrs jxs jxsc jxsi jxss ktx ktx2 m1v m2t m2ts m2v m4s m4u m4v mdi mj2 mjp2 mk3d mks mkv mmr mng mov movie " +
            "mp4 mp4v mpe mpeg mpg mpg4 mts mxu npx ogv pbm pct pcx pgm pic png pnm ppm psd pti pyv qt ras rgb rlc sgi sid " +
            "smv svg svgz t38 tap tfx tga tif tiff uvg uvh uvi uvm uvp uvs uvu uvv uvvg uvvh uvvi uvvm uvvp uvvs uvvu uvvv " +
            "viv vob vtf wbmp wdp webm webp wm wmf wmv wmx wvx xbm xif xpm xwd"
        ).split(" "),
    ),
)
const attachmentUrl = (value: unknown, uploadedFilenames: readonly string[] | undefined): string | undefined => {
    if (typeof value !== "string" || value.length < 1 || value.length > 2048) return undefined
    if (!value.startsWith("attachment://")) return url(value) as string | undefined
    const filename = value.slice("attachment://".length)
    const extension = filename.split(".").pop()?.toLowerCase()
    const matches = uploadedFilenames?.filter((uploaded) => uploaded === filename).length ?? 0
    return /^[\p{L}\p{N}\p{M}_.-]+$/u.test(filename) &&
        matches === 1 &&
        extension !== undefined &&
        attachmentMediaExtensions.has(extension)
        ? value
        : undefined
}
const timestamp: Reader = (value) => (isoTimestamp(value) ? value : undefined)

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

// Names each input path in explanations, so a failure reads without knowing the path syntax
const subjects: Readonly<Record<string, string>> = {
    embeds: "Embeds",
    "embeds[]": "Each embed",
    "embeds[].author": "Embed author",
    "embeds[].footer": "Embed footer",
    "embeds[].image": "Embed image",
    "embeds[].thumbnail": "Embed thumbnail",
    "embeds[].fields": "Embed fields",
    "embeds[].fields[]": "Each embed field",
}

function projectInput(value: unknown, shape: Shape, path: string): Record<string, unknown> | InputValidationFailure {
    const subject = subjects[path] ?? "Embed input"
    if (!object(value)) return inputValidationFailure(path, "type", `${subject} must be an object`)
    const unsupported = unsupportedKeyFailure(
        value,
        Object.keys(shape),
        path,
        path.endsWith("[]") ? `an ${subject.slice("Each ".length).toLowerCase()}` : `the ${subject.toLowerCase()}`,
    )
    if (unsupported) return unsupported
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
    if (!Array.isArray(value))
        return inputValidationFailure(path, "type", `${subjects[path] ?? "Embed input"} must be an array`)
    const count = value.length
    if (count > maximum)
        return inputValidationFailure(
            path,
            "length",
            `${subjects[path] ?? "Embed input"} may contain at most ${maximum} entries`,
        )
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
        ["length", "Embed author name must contain 1 through 256 UTF-16 code units after Fluxer's normalization"],
    ],
    url: ["url", url, false, ["format", "Embed author URL must be an HTTP or HTTPS URL of at most 2,048 characters"]],
    iconUrl: [
        "icon_url",
        url,
        false,
        ["format", "Embed author iconUrl must be an HTTP or HTTPS URL of at most 2,048 characters"],
    ],
}
const inputFooter: Shape = {
    text: [
        "text",
        length(1, 2048),
        true,
        ["length", "Embed footer text must contain 1 through 2,048 UTF-16 code units after Fluxer's normalization"],
    ],
    iconUrl: [
        "icon_url",
        url,
        false,
        ["format", "Embed footer iconUrl must be an HTTP or HTTPS URL of at most 2,048 characters"],
    ],
}
const inputMedia = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    url: [
        "url",
        (value) => attachmentUrl(value, uploadedFilenames),
        true,
        [
            "format",
            "Embed media URL must be an HTTP or HTTPS URL, or attachment://<filename> naming exactly one uploaded file whose filename maps to an image or video MIME type",
        ],
    ],
    description: [
        "description",
        length(1, 4096),
        false,
        [
            "length",
            "Embed media description must contain 1 through 4,096 UTF-16 code units after Fluxer's normalization",
        ],
    ],
})
const inputField: Shape = {
    name: [
        "name",
        length(1, 256),
        true,
        ["length", "Embed field name must contain 1 through 256 UTF-16 code units after Fluxer's normalization"],
    ],
    value: [
        "value",
        length(0, 1024),
        true,
        ["length", "Embed field value must contain at most 1,024 UTF-16 code units after Fluxer's normalization"],
    ],
    inline: ["inline", boolean, false, ["type", "Embed field inline must be a boolean"]],
}
const inputEmbed = (uploadedFilenames: readonly string[] | undefined): Shape => ({
    title: [
        "title",
        length(0, 256),
        false,
        ["length", "Embed title must contain at most 256 UTF-16 code units after Fluxer's normalization"],
    ],
    description: [
        "description",
        (value) => (value === "" ? value : length(1, 4096)(value)),
        false,
        [
            "length",
            "Embed description must be empty or contain 1 through 4,096 UTF-16 code units after Fluxer's normalization",
        ],
    ],
    url: ["url", url, false, ["format", "Embed URL must be an HTTP or HTTPS URL of at most 2,048 characters"]],
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
const outputProvider: Shape = {
    name: ["name", string, true],
    url: ["url", string],
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
    provider: ["provider", (value, construct) => project(value, outputProvider, construct)],
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

/** Media targets using attachment:// need an unambiguous new upload in this request. Retained IDs never imply a filename lookup */
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
