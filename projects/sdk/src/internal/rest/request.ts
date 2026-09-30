/**
 * Caller-described REST requests for client.rest.request: Input validation, path and query encoding, log-safe route
 * templates and the bounded response reader.
 * Invariant: A request leaves validation only with a relative API path that cannot change the scheme, host or /v1 base,
 * reach a parent path or carry a webhook credential. Logs see only the caller route template, and a response body is
 * read within the JSON limit or not at all.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { RestResponse } from "#sdk/rest"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { encodeAttachments, type EncodedBody } from "../attachments.js"
import { auditSettings } from "../audit.js"
import { record } from "../decode/primitives.js"
import { callerRouteTemplate } from "../rate-limits.js"
import { ResponseJsonCleanupError } from "../response-json.js"
import { RestFailure } from "./classify.js"

/** Longest accepted path, before the query */
const pathMaxLength = 2_048
/** Longest encoded query string, without its leading question mark */
const queryMaxLength = 8_192
/** Largest response body read, matching the SDK's JSON response limit */
const responseMaxBytes = 16_777_216
/** Longest accepted operation deadline */
const maximumTimerMs = 2_147_483_647

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
const fields = ["method", "path", "query", "body", "files", "auditReason", "timeoutMs", "signal"]
/** Resource names whose following numeric segment is the request's major resource for rate-limit grouping */
const majorResources = new Set(["channels", "guilds", "webhooks", "users"])

/** A validated caller request, ready for the owner's scheduler */
export interface EncodedRestRequest {
    readonly method: (typeof methods)[number]
    /** Path after /v1 with the encoded query appended */
    readonly path: string
    /** Log-safe route template */
    readonly template: string
    /** The first channel, guild, webhook or user ID in the path, or rest when there is none */
    readonly major: string
    readonly body: EncodedBody | undefined
    readonly auditReason: string | undefined
    readonly timeoutMs: number | undefined
}

/** Check a path's shape. Invalid percent escapes and every character outside RFC 3986 path characters are rejected */
function pathFailure(path: unknown): InputValidationFailure | undefined {
    if (typeof path !== "string") return inputValidationFailure("path", "type", "REST paths must be strings")
    if (path.length < 2 || path.length > pathMaxLength)
        return inputValidationFailure("path", "length", "REST paths must contain 2 through 2,048 characters")
    if (!path.startsWith("/") || path.startsWith("//"))
        return inputValidationFailure(
            "path",
            "format",
            "REST paths must be relative API paths that start with one slash, such as /users/@me",
        )
    if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/.test(path) || /%(?![0-9A-Fa-f]{2})/.test(path))
        return inputValidationFailure(
            "path",
            "format",
            "REST paths may contain only URL path characters and valid percent escapes, with the query in query and no fragment",
        )
    const segments = path
        .slice(1)
        .split("/")
        .map((segment) =>
            segment.replace(/%([0-9A-Fa-f]{2})/g, (encoded, hex: string) => {
                const character = String.fromCharCode(parseInt(hex, 16))
                return /^[A-Za-z0-9\-._~]$/.test(character) ? character : encoded
            }),
        )
    if (
        segments.some((segment) => {
            const decoded = segment.replace(/%2e/gi, ".")
            return segment === "" || decoded === "." || decoded === ".." || /%(?:2f|5c)/i.test(segment)
        })
    )
        return inputValidationFailure(
            "path",
            "format",
            "REST paths may not contain empty, dot or dot-dot segments or encoded slashes",
        )
    if (segments[0] === "v1")
        return inputValidationFailure("path", "format", "REST paths are relative to /v1, so omit the version prefix")
    if (segments[0] === "webhooks" && segments.length > 2)
        return inputValidationFailure(
            "path",
            "format",
            "Token-authenticated webhook routes carry a credential in the path and are not supported. Use a webhook client",
        )
    return undefined
}

/** Encode query parameters in insertion order, skipping undefined values */
function encodeQuery(query: unknown): string | InputValidationFailure {
    if (query === undefined) return ""
    if (!record(query) || Array.isArray(query))
        return inputValidationFailure(
            "query",
            "type",
            "REST query must be an object of string, number or boolean values",
        )
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue
        if (key === "") return inputValidationFailure("query", "format", "REST query parameter names must not be empty")
        if (typeof value === "number" && !Number.isFinite(value))
            return inputValidationFailure("query", "type", "REST query numbers must be finite")
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
            return inputValidationFailure(
                "query",
                "type",
                "REST query must be an object of string, number or boolean values",
            )
        params.append(key, String(value))
    }
    const encoded = params.toString()
    if (encoded.length > queryMaxLength)
        return inputValidationFailure("query", "length", "The encoded REST query must not exceed 8,192 characters")
    return encoded
}

/** Serialize the JSON body and any files, which Fluxer's multipart convention describes in body.attachments */
function encodeBody(
    method: EncodedRestRequest["method"],
    body: unknown,
    files: unknown,
): EncodedBody | undefined | InputValidationFailure {
    if (method === "GET" && body !== undefined)
        return inputValidationFailure("body", "relationship", "GET requests cannot have a body")
    if (method === "GET" && files !== undefined)
        return inputValidationFailure("files", "relationship", "GET requests cannot have files")
    if (files !== undefined && !Array.isArray(files))
        return inputValidationFailure("files", "type", "REST files must be an array of attachment inputs")
    const attachments = encodeAttachments(files ?? [], false)
    if (attachments instanceof InputValidationFailure) {
        const { path, constraint, explanation } = attachments.detail
        return inputValidationFailure(path.replace(/^attachments/, "files"), constraint, explanation)
    }
    if (
        attachments.files.length &&
        body !== undefined &&
        (!record(body) || Array.isArray(body) || "attachments" in body)
    )
        return inputValidationFailure(
            "body",
            "relationship",
            "With files, the body must be omitted or a JSON object without attachments",
        )
    if (body === undefined && !attachments.files.length) return undefined
    let json: string | undefined
    try {
        json = JSON.stringify(
            attachments.files.length ? { ...(body as object | undefined), attachments: attachments.metadata } : body,
        )
    } catch {
        // allow-silent: An unserializable body becomes the typed input failure returned below
        json = undefined
    }
    if (json === undefined) return inputValidationFailure("body", "type", "REST bodies must be JSON-serializable")
    return { json, files: attachments.files }
}

/** The first channel, guild, webhook or user ID, which groups provisional rate-limit state like SDK operations */
function majorResource(segments: readonly string[]): string {
    for (let index = 0; index < segments.length - 1; index++)
        if (majorResources.has(segments[index]!) && /^\d+$/.test(segments[index + 1]!)) return segments[index + 1]!
    return "rest"
}

/** Validate one caller request. Failures carry SDK-authored paths and explanations, never the rejected values */
export function encodeRestRequest(input: unknown): EncodedRestRequest | InputValidationFailure {
    if (!record(input) || Array.isArray(input))
        return inputValidationFailure("input", "type", "REST requests must be objects")
    const unsupported = unsupportedKeyFailure(input, fields, "input", "the REST request")
    if (unsupported) return unsupported
    const method = input.method
    if (!methods.includes(method as EncodedRestRequest["method"]))
        return inputValidationFailure("method", "allowedValue", "REST methods must be GET, POST, PUT, PATCH or DELETE")
    const path = input.path
    const invalidPath = pathFailure(path)
    if (invalidPath) return invalidPath
    const query = encodeQuery(input.query)
    if (query instanceof InputValidationFailure) return query
    const body = encodeBody(method as EncodedRestRequest["method"], input.body, input.files)
    if (body instanceof InputValidationFailure) return body
    const audit = auditSettings({ auditReason: input.auditReason })
    if (audit instanceof InputValidationFailure) {
        const { constraint, explanation } = audit.detail
        return inputValidationFailure("auditReason", constraint, explanation)
    }
    const timeoutMs = input.timeoutMs
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > maximumTimerMs)
    )
        return inputValidationFailure(
            "timeoutMs",
            "range",
            "REST timeoutMs must be an integer from 1 through 2,147,483,647 ms",
        )
    const pathname = path as string
    return {
        method: method as EncodedRestRequest["method"],
        path: query ? `${pathname}?${query}` : pathname,
        template: callerRouteTemplate(pathname),
        major: majorResource(pathname.slice(1).split("/")),
        body,
        auditReason: audit.auditReason,
        timeoutMs: timeoutMs as number | undefined,
    }
}

/** Read a body within the JSON limit. The result is undefined when empty and a failure when oversized or not JSON */
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
    const invalid = () => new RestFailure({ reason: "response", outcome: "unknown", status: response.status })
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let text = ""
    let bytes = 0
    let ended = false
    let failure: RestFailure | undefined
    let value: unknown
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) {
                ended = true
                break
            }
            bytes += next.value.byteLength
            if (bytes > responseMaxBytes) {
                failure = invalid()
                break
            }
            text += decoder.decode(next.value, { stream: true })
        }
        if (!failure) {
            text += decoder.decode()
            if (bytes > 0) value = JSON.parse(text) as unknown
        }
    } catch {
        // allow-silent: A body that is not UTF-8 JSON becomes the typed response failure returned below
        failure = invalid()
    }
    const cleanup: unknown[] = []
    const actions: (() => Promise<void> | void)[] = [
        ...(ended ? [] : [() => reader.cancel()]),
        () => reader.releaseLock(),
    ]
    for (const action of actions) {
        try {
            await action()
        } catch (error) {
            // Re-cancelling a fetch reader after its own request abort can reject with that exact reason
            if (!(signal.aborted && error === signal.reason)) cleanup.push(error)
        }
    }
    if (cleanup.length)
        throw new ResponseJsonCleanupError(
            cleanup.length === 1 ? cleanup[0] : new AggregateError(cleanup, "REST response cleanup failed"),
            response.status,
        )
    if (failure) throw failure
    return value
}

/** Project an accepted response: Its status, lower-case headers and parsed body */
export async function readRestResponse<T>(response: Response, signal: AbortSignal): Promise<RestResponse<T>> {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
        headers[name] = value
    })
    const body = (await readBody(response, signal)) as T
    return Object.freeze({ status: response.status, headers: Object.freeze(headers), body })
}
