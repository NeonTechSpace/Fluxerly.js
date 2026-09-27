/**
 * Attachment downloads: Buffered downloads and one-shot streamed readers over the selected instance's media URLs.
 * Invariant: Downloads accept only the selected instance's media attachment URLs, enforce the caller's output limit and
 * deadline, send no credential or cookie, and hold one media slot until end of stream, cancellation or release.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { Attachment, AttachmentDownloadFailure, AttachmentDownloadOptions } from "#sdk/attachments"
import { AttachmentDownloadError } from "#sdk/attachments"
import { ClientClosedError, ConnectionError } from "#sdk/errors"
import type { MessageCore } from "#sdk/messages"
import { inputValidationFailure, unsupportedKeyFailure, type InputValidationConstraint } from "#sdk/input-validation"
import { record } from "../decode/primitives.js"
import { readCaller, suspendMarked, thrownCause } from "../defects.js"
import { mapFailureCause, withDeadline } from "../effect-failures.js"
import type { InstanceEndpointContext } from "../instance.js"
import type { HttpTransport } from "../transport/index.js"
import { completeCleanup } from "./attempt.js"
import { RestFailure } from "./classify.js"
import type { RestRuntime } from "./owner.js"

/** Largest accepted maxBytes, 50 MiB */
const maximumDownloadBytes = 52_428_800
/** Longest single timer delay */
const maximumTimerMs = 2_147_483_647
/** Longest accepted attachment URL */
const maximumUrlLength = 8192

/**
 * Internal-only cleanup defect. It keeps the reader's or cleanup step's thrown value as its cause, and SDK error text
 * masks credentials when it is reported
 */
class AttachmentStreamCleanupError extends Error {
    constructor(cause?: unknown) {
        super("Attachment stream cleanup failed", cause === undefined ? undefined : { cause })
        this.name = "AttachmentStreamCleanupError"
    }
}

/** Most stream cleanup failures retained for shutdown. Later ones are counted and reported without their values */
const retainedCleanupDefects = 64

/** Stream cleanup failures that no caller observed, kept with their original values until shutdown reports them */
export class UnobservedDownloadDefects {
    readonly #defects = new Set<Cause.Cause<never>>()
    #overflow = 0

    add(defect: Cause.Cause<never>) {
        if (this.#defects.size < retainedCleanupDefects) this.#defects.add(defect)
        else this.#overflow = Math.min(Number.MAX_SAFE_INTEGER, this.#overflow + 1)
    }

    remove(defect: Cause.Cause<never>) {
        if (!this.#defects.delete(defect) && this.#overflow > 0 && this.#overflow < Number.MAX_SAFE_INTEGER)
            this.#overflow--
    }

    /** Take every retained failure as one Cause, or undefined when none is left */
    take(): Cause.Cause<never> | undefined {
        const defects = [...this.#defects]
        this.#defects.clear()
        if (this.#overflow > 0) defects.push(Cause.die(new AttachmentStreamCleanupError()))
        this.#overflow = 0
        return defects.length > 0 ? defects.reduce((all, defect) => Cause.combine(all, defect)) : undefined
    }
}

/** Owner hooks and limits for one streamed download */
interface DownloadSourceOptions {
    readonly controller: AbortController
    readonly maxBytes: number
    /** Wall-clock deadline in epoch milliseconds */
    readonly deadline: number
    /** Release the media slot */
    readonly release: () => void
    /** Called once after the source closed, successfully or not */
    readonly onClose: () => void
    /** Called once with the cleanup failure, before any caller observed it */
    readonly onDefect: (defect: Cause.Cause<never>) => void
    /** Called once when a caller observed the cleanup failure through closeEffect */
    readonly onDefectObserved: (defect: Cause.Cause<never>) => void
    readonly http: HttpTransport
}

/** One one-shot media response reader. It retains one media HTTP slot until EOF, cancellation, or release */
export class AttachmentDownloadSource {
    #reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    #response: Response | undefined
    #opening: Promise<Response> | undefined
    #ended = false
    #closed = false
    #reading = false
    #total = 0
    #failure: AttachmentDownloadFailure | undefined
    #interrupted = false
    #close: Promise<void> | undefined
    /** Cleanup failure of the finished source, reported by every closeEffect */
    #defect: Cause.Cause<never> | undefined
    /** The failure handed to onDefect, so the owner can match it when a caller observes it */
    #recorded: Cause.Cause<never> | undefined
    #defectObserved = false
    #timer: ReturnType<typeof setTimeout> | undefined
    #removeSignal: (() => void) | undefined
    /** Caller-side signal cleanup, kept out of the SDK cleanup steps so a throw keeps its own origin */
    #signalClosed: (() => void) | undefined

    constructor(private readonly options: DownloadSourceOptions) {
        const remaining = options.deadline - Date.now()
        this.#timer = setTimeout(
            () => this.fail(new AttachmentDownloadError({ reason: "timeout" })),
            Math.max(1, remaining),
        )
    }

    open(url: string): Promise<Response> {
        this.#opening = this.options
            .http(url, { method: "GET", redirect: "error", signal: this.options.controller.signal })
            .then((response) => {
                this.#response = response
                return response
            })
        return this.#opening.catch((error) => {
            throw this.#failure ?? error
        })
    }

    accept(response: Response, verifyLength = true) {
        if (this.#closed) throw this.#failure ?? new ClientClosedError()
        this.#response = response
        const declared = response.headers.get("content-length")
        if (verifyLength && declared !== null) {
            if (!/^\d+$/.test(declared))
                throw new AttachmentDownloadError({ reason: "response", status: response.status })
            if (Number(declared) > this.options.maxBytes)
                throw new AttachmentDownloadError({ reason: "tooLarge", status: response.status })
        }
        this.#reader = response.body?.getReader()
    }

    /**
     * Bind default cancellation through the source so it also releases an idle stream. The onClose callback runs after
     * the SDK cleanup steps, and a throw from a marked caller read in it is reported as an application fault
     */
    bindSignal(
        signal: {
            readonly aborted: boolean
            addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
            removeEventListener(type: "abort", listener: () => void): void
        },
        onClose: () => void,
    ) {
        const abort = () => this.interrupt()
        signal.addEventListener("abort", abort, { once: true })
        this.#removeSignal = () => signal.removeEventListener("abort", abort)
        this.#signalClosed = onClose
        if (signal.aborted) abort()
    }

    interrupt() {
        if (this.#closed) return
        this.#interrupted = true
        this.#closeInBackground()
    }

    fail(error: AttachmentDownloadFailure) {
        if (this.#closed) return
        this.#failure = error
        this.#closeInBackground()
    }

    #closeInBackground() {
        // allow-silent: The close() call retains the cleanup defect for the next operation boundary
        void this.close().catch(() => {
            // A later source finalizer or operation boundary retains this cleanup defect
        })
    }

    #recordDefect(defect: Cause.Cause<never>) {
        this.#defect = this.#defect ? Cause.combine(this.#defect, defect) : defect
        if (this.#recorded) return
        this.#recorded = this.#defect
        this.options.onDefect(this.#recorded)
    }

    async #finish() {
        if (this.#closed) return
        this.#closed = true
        clearTimeout(this.#timer)
        this.#timer = undefined
        const controller = this.options.controller
        controller.abort()
        // Await a late response before releasing its body or declaring the operation closed
        // allow-silent: The opening request's own failure is reported by the operation that started it
        await this.#opening?.catch(() => undefined)
        this.#opening = undefined
        const reader = this.#reader
        this.#reader = undefined
        const response = this.#response
        this.#response = undefined
        const removeSignal = this.#removeSignal
        this.#removeSignal = undefined
        const signalClosed = this.#signalClosed
        this.#signalClosed = undefined
        const cancel = async (body: Pick<ReadableStream<Uint8Array>, "cancel">) => {
            try {
                await body.cancel()
            } catch (error) {
                if (error !== controller.signal.reason) throw error
            }
        }
        let defect: Cause.Cause<never> = Cause.empty
        try {
            await completeCleanup([
                () => controller.abort(),
                ...(!this.#ended && reader ? [() => cancel(reader)] : []),
                ...(reader ? [() => reader.releaseLock()] : []),
                ...(!reader && response && !response.bodyUsed && response.body ? [() => cancel(response.body!)] : []),
                () => removeSignal?.(),
                () => this.options.release(),
            ])
        } catch (error) {
            defect = Cause.die(new AttachmentStreamCleanupError(error))
        }
        try {
            signalClosed?.()
        } catch (error) {
            defect = Cause.combine(defect, thrownCause(error))
        } finally {
            if (defect.reasons.length > 0) this.#recordDefect(defect)
            this.options.onClose()
        }
    }

    close(): Promise<void> {
        this.#close ??= this.#finish().catch((error: unknown) => {
            this.#recordDefect(Cause.die(error))
        })
        return this.#close
    }

    readonly closeEffect: Effect.Effect<void> = Effect.promise(() => this.close()).pipe(
        Effect.andThen(
            Effect.suspend(() => {
                const defect = this.#defect
                if (!defect) return Effect.void
                if (!this.#defectObserved) {
                    this.#defectObserved = true
                    this.options.onDefectObserved(this.#recorded ?? defect)
                }
                return Effect.failCause(defect)
            }),
        ),
    )

    readonly next: Effect.Effect<Uint8Array | undefined, AttachmentDownloadFailure> = Effect.suspend(() => {
        if (this.#interrupted) return Effect.interrupt.pipe(Effect.ensuring(this.closeEffect))
        if (this.#failure) return Effect.fail(this.#failure).pipe(Effect.ensuring(this.closeEffect))
        if (this.#closed || this.#ended) return Effect.succeed(undefined)
        if (this.#reading) return Effect.fail(new AttachmentDownloadError({ reason: "busy" }))
        const reader = this.#reader
        if (!reader) {
            this.#ended = true
            return this.closeEffect.pipe(Effect.as(undefined))
        }
        this.#reading = true
        return Effect.tryPromise({
            try: async () => {
                const value = await reader.read()
                if (this.#interrupted)
                    throw new AttachmentDownloadError({ reason: "network", status: this.#response?.status ?? null })
                if (this.#failure) throw this.#failure
                if (value.done) {
                    this.#ended = true
                    return undefined
                }
                if (!(value.value instanceof Uint8Array) || !(value.value.buffer instanceof ArrayBuffer))
                    throw new AttachmentDownloadError({ reason: "response", status: this.#response?.status ?? null })
                this.#total += value.value.byteLength
                if (!Number.isSafeInteger(this.#total) || this.#total > this.options.maxBytes)
                    throw new AttachmentDownloadError({ reason: "tooLarge", status: this.#response?.status ?? null })
                return value.value
            },
            catch: (error) =>
                this.#failure ??
                (error instanceof AttachmentDownloadError
                    ? error
                    : new AttachmentDownloadError({ reason: "network", status: this.#response?.status ?? null })),
        }).pipe(
            Effect.catchIf(
                () => this.#interrupted,
                () => Effect.interrupt,
            ),
            Effect.catchIf(
                () => this.#failure !== undefined,
                () => Effect.fail(this.#failure!),
            ),
            Effect.ensuring(
                Effect.sync(() => {
                    this.#reading = false
                }),
            ),
            Effect.flatMap((value) =>
                value === undefined ? this.closeEffect.pipe(Effect.as(undefined)) : Effect.succeed(value),
            ),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? this.closeEffect : Effect.void)),
        )
    })
}

function downloadInput(
    attachment: Attachment,
    options: AttachmentDownloadOptions | undefined,
    streamed: boolean,
    defaultTimeoutMs: number,
) {
    const invalid = (path: string, constraint: InputValidationConstraint, explanation: string) =>
        new AttachmentDownloadError({
            reason: "input",
            inputValidation: inputValidationFailure(path, constraint, explanation).detail,
        })
    if (!record(options)) return invalid("options", "type", "Attachment download options must be an object")
    const maxBytes = options.maxBytes
    const attachmentUrl = attachment?.url
    const unsupported = unsupportedKeyFailure(
        options,
        ["maxBytes", "timeoutMs", "signal"],
        "options",
        "the attachment download options",
    )
    if (unsupported) return new AttachmentDownloadError({ reason: "input", inputValidation: unsupported.detail })
    if (streamed) {
        // Buffered default calls validate cancellation at their operation adapter, while a stream owns its idle signal
        const signal = options.signal
        if (
            signal !== undefined &&
            (!record(signal) ||
                typeof signal.aborted !== "boolean" ||
                typeof signal.addEventListener !== "function" ||
                typeof signal.removeEventListener !== "function")
        )
            return invalid("options.signal", "type", "Attachment signal must be AbortSignal-compatible")
    }
    if (
        typeof maxBytes !== "number" ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        maxBytes > maximumDownloadBytes
    )
        return invalid(
            "options.maxBytes",
            "range",
            "Attachment maxBytes must be an integer from 1 through 52,428,800 bytes (50 MiB)",
        )
    const timeoutMs = options.timeoutMs
    const timeout = timeoutMs === undefined ? defaultTimeoutMs : timeoutMs
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximumTimerMs)
        return invalid(
            "options.timeoutMs",
            "range",
            "Attachment timeoutMs must be an integer from 1 through 2,147,483,647 ms",
        )
    return { maxBytes, timeout, attachmentUrl }
}

function attachmentDownloadUrl(value: unknown, instance: InstanceEndpointContext): string | undefined {
    if (typeof value !== "string" || value.length < 1 || value.length > maximumUrlLength) return undefined
    try {
        const base = new URL(instance.media)
        const url = new URL(value)
        const path = `${base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "")}/attachments/`
        return (base.protocol === "https:" || (instance.allowInsecure && base.protocol === "http:")) &&
            base.username === "" &&
            base.password === "" &&
            url.protocol === base.protocol &&
            url.origin === base.origin &&
            url.username === "" &&
            url.password === "" &&
            url.hash === "" &&
            url.pathname.startsWith(path)
            ? url.toString()
            : undefined
    } catch {
        // allow-silent: An unparsable URL is not an instance attachment URL
        return undefined
    }
}

/** The owner's resolved instance, discovering it through a media slot on first use */
function mediaInstance<M extends MessageCore>(runtime: RestRuntime<M>) {
    return Effect.gen(function* () {
        const resolved = runtime.instance
        const instance =
            resolved ??
            (yield* Effect.acquireUseRelease(
                Effect.interruptible(
                    runtime.admission.acquire({ route: "media:discovery", bytes: 0, rateLimited: false, media: true }),
                ),
                () => runtime.resolveInstance(),
                (release) => Effect.sync(release),
            ).pipe(
                mapFailureCause((error) =>
                    error instanceof ClientClosedError
                        ? error
                        : error instanceof RestFailure
                          ? new AttachmentDownloadError({
                                reason: error.reason === "busy" ? "busy" : "network",
                                status: error.status,
                            })
                          : new AttachmentDownloadError({
                                reason: "network",
                                status: error instanceof ConnectionError ? error.status : null,
                            }),
                ),
            ))
        if (!resolved) runtime.instance = instance
        return instance
    })
}

/** Wait for a media download slot. Media has its own slots so lazy upload sources cannot exhaust their own GETs */
function mediaSlot<M extends MessageCore>(runtime: RestRuntime<M>) {
    return runtime.admission
        .acquire({ route: "media:download", bytes: 0, rateLimited: false, media: true })
        .pipe(Effect.interruptible)
        .pipe(
            mapFailureCause((error) =>
                error instanceof ClientClosedError
                    ? error
                    : error instanceof RestFailure
                      ? new AttachmentDownloadError({
                            reason: error.reason === "busy" ? "busy" : "network",
                            status: error.status,
                        })
                      : new AttachmentDownloadError({ reason: "network" }),
            ),
        )
}

/** Open a streamed download that holds its media slot until the reader ends, fails or is released */
export function openAttachmentStream<M extends MessageCore>(
    runtime: RestRuntime<M>,
    attachment: Attachment,
    options?: AttachmentDownloadOptions,
): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> {
    // Only reading the caller attachment and options is marked, so a throw there is an application fault
    return suspendMarked((): Effect.Effect<AttachmentDownloadSource, AttachmentDownloadFailure> => {
        if (runtime.closed) return Effect.fail(new ClientClosedError())
        const input = readCaller(() => downloadInput(attachment, options, true, runtime.settings.defaultTimeoutMs))
        if (input instanceof AttachmentDownloadError) return Effect.fail(input)
        const { maxBytes, timeout, attachmentUrl } = input
        const operation = Deferred.makeUnsafe<void>()
        runtime.operations.add(operation)
        const complete = () => {
            runtime.operations.delete(operation)
            Deferred.doneUnsafe(operation, Effect.void)
        }
        let source: AttachmentDownloadSource | undefined
        const deadline = Date.now() + timeout
        return Effect.gen(function* () {
            const instance = yield* mediaInstance(runtime)
            const url = attachmentDownloadUrl(attachmentUrl, instance)
            if (!url) return yield* Effect.fail(new AttachmentDownloadError({ reason: "untrustedUrl" }))
            const release = yield* mediaSlot(runtime)
            const controller = new AbortController()
            runtime.controllers.add(controller)
            source = new AttachmentDownloadSource({
                controller,
                maxBytes,
                deadline,
                release,
                onClose: () => {
                    runtime.controllers.delete(controller)
                    runtime.downloads.delete(source!)
                    complete()
                },
                onDefect: (defect) => runtime.unobservedDownloadDefects.add(defect),
                onDefectObserved: (defect) => runtime.unobservedDownloadDefects.remove(defect),
                http: runtime.http,
            })
            runtime.downloads.add(source)
            const response = yield* Effect.tryPromise({
                try: () => source!.open(url),
                catch: (error) =>
                    error instanceof AttachmentDownloadError
                        ? error
                        : new AttachmentDownloadError({ reason: "network" }),
            })
            try {
                source.accept(response, response.ok)
            } catch (error) {
                return yield* Effect.fail(
                    error instanceof AttachmentDownloadError || error instanceof ClientClosedError
                        ? error
                        : new AttachmentDownloadError({ reason: "network", status: response.status }),
                )
            }
            if (controller.signal.aborted) return yield* Effect.fail(new ClientClosedError())
            if (!response.ok)
                return yield* Effect.fail(new AttachmentDownloadError({ reason: "response", status: response.status }))
            return source
        }).pipe(
            withDeadline(timeout, () => new AttachmentDownloadError({ reason: "timeout" })),
            Effect.onExit((exit) =>
                Exit.isFailure(exit) ? (source ? source.closeEffect : Effect.sync(complete)) : Effect.void,
            ),
        )
    })
}

/** Download a whole attachment into memory within its byte limit and deadline */
export function downloadAttachment<M extends MessageCore>(
    runtime: RestRuntime<M>,
    attachment: Attachment,
    options?: AttachmentDownloadOptions,
): Effect.Effect<Uint8Array, AttachmentDownloadFailure> {
    // Only reading the caller attachment and options is marked, so a throw there is an application fault
    return suspendMarked((): Effect.Effect<Uint8Array, AttachmentDownloadFailure> => {
        if (runtime.closed) return Effect.fail(new ClientClosedError())
        const input = readCaller(() => downloadInput(attachment, options, false, runtime.settings.defaultTimeoutMs))
        if (input instanceof AttachmentDownloadError) return Effect.fail(input)
        const { maxBytes, timeout, attachmentUrl } = input
        const operation = Deferred.makeUnsafe<void>()
        runtime.operations.add(operation)
        let controller: AbortController | undefined
        let response: Response | undefined
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let ended = false
        let settled = Promise.resolve()
        let release: (() => void) | undefined
        const cancel = async (action: () => void | PromiseLike<void>) => {
            try {
                await action()
            } catch (error) {
                // Fetch can return this controller's exact abort reason while closing its own body
                if (!(controller?.signal.aborted && error === controller.signal.reason)) throw error
            }
        }
        const closeBody = async () => {
            if (reader) {
                const current = reader
                reader = undefined
                await completeCleanup([
                    ...(!ended ? [() => cancel(() => current.cancel())] : []),
                    () => current.releaseLock(),
                ])
            } else if (response && !response.bodyUsed) {
                const body = response.body
                if (body) await cancel(() => body.cancel())
            }
        }
        return Effect.gen(function* () {
            const instance = yield* mediaInstance(runtime)
            const url = attachmentDownloadUrl(attachmentUrl, instance)
            if (!url) return yield* Effect.fail(new AttachmentDownloadError({ reason: "untrustedUrl" }))
            release = yield* mediaSlot(runtime)
            controller = new AbortController()
            runtime.controllers.add(controller)
            return yield* Effect.tryPromise({
                try: () => {
                    const work = (async () => {
                        response = await runtime.http(url, {
                            method: "GET",
                            redirect: "error",
                            signal: controller!.signal,
                        })
                        if (controller!.signal.aborted) {
                            throw controller!.signal.reason ?? new Error("Attachment download aborted")
                        }
                        if (!response.ok)
                            throw new AttachmentDownloadError({ reason: "response", status: response.status })
                        const declared = response.headers.get("content-length")
                        if (declared !== null) {
                            if (!/^\d+$/.test(declared))
                                throw new AttachmentDownloadError({ reason: "response", status: response.status })
                            if (Number(declared) > maxBytes)
                                throw new AttachmentDownloadError({ reason: "tooLarge", status: response.status })
                        }
                        reader = response.body?.getReader()
                        if (!reader) {
                            ended = true
                            return new Uint8Array()
                        }
                        const chunks: Uint8Array[] = []
                        let total = 0
                        while (true) {
                            const next = await reader.read()
                            if (next.done) {
                                ended = true
                                break
                            }
                            if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer))
                                throw new AttachmentDownloadError({ reason: "response", status: response.status })
                            total += next.value.byteLength
                            if (!Number.isSafeInteger(total) || total > maxBytes)
                                throw new AttachmentDownloadError({ reason: "tooLarge", status: response.status })
                            chunks.push(next.value)
                        }
                        const output = new Uint8Array(total)
                        let offset = 0
                        for (const chunk of chunks) {
                            output.set(chunk, offset)
                            offset += chunk.byteLength
                        }
                        return output
                    })()
                    // allow-silent: The work promise itself is returned and its rejection observed by the caller, so this only records settlement
                    settled = work.then(
                        () => undefined,
                        () => undefined,
                    )
                    return work
                },
                catch: (error) =>
                    error instanceof AttachmentDownloadError
                        ? error
                        : new AttachmentDownloadError({ reason: "network", status: response?.status ?? null }),
            })
        }).pipe(
            withDeadline(timeout, () => new AttachmentDownloadError({ reason: "timeout" })),
            Effect.ensuring(
                Effect.uninterruptible(
                    Effect.promise(async () => {
                        await completeCleanup([
                            () => controller?.abort(),
                            () => closeBody(),
                            () => settled,
                            () => closeBody(),
                            () => release?.(),
                            () => {
                                if (controller) runtime.controllers.delete(controller)
                            },
                        ])
                    }).pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                runtime.operations.delete(operation)
                                Deferred.doneUnsafe(operation, Effect.void)
                            }),
                        ),
                    ),
                ),
            ),
        )
    })
}
