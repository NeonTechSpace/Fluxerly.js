// Lazy singleton bridge between CodeMirror 6 and the static TypeScript 6.0 Web Worker.
// Keeps initial page load at zero extra bytes, isolates boot attempts, self-heals stale deploy manifests
// and degrades cleanly without retry storms if the worker cannot start
import type {
    MainToTsWorkerMessage,
    TsAssetManifest,
    TsCompletionDetails,
    TsCompletionItem,
    TsDiagnostic,
    TsQuickInfo,
    TsWorkerToMainMessage,
} from "../playground-ts/protocol"

export interface CompletionResponse {
    readonly from: number
    readonly to: number
    readonly items: readonly TsCompletionItem[]
    readonly isIncomplete?: boolean
}

interface PendingResolver<T> {
    readonly resolve: (value: T) => void
}

type DiagnosticsListener = (fileName: string, version: number, diagnostics: readonly TsDiagnostic[]) => void
type StatusListener = (status: TsClientStatus) => void

export type TsClientStatus =
    | { readonly state: "idle" }
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly bootMs: number; readonly hasEffect: boolean }
    | { readonly state: "error"; readonly message: string }

const maxAutoFailures = 2
const retryCooldownMs = 5_000

class PlaygroundTsClient {
    private worker: Worker | null = null
    private status: TsClientStatus = { state: "idle" }
    private bootPromise: Promise<boolean> | null = null
    private bootToken = 0
    private bootAbort: AbortController | null = null
    private consecutiveFailures = 0
    private nextRetryAt = 0

    private nextId = 1
    private latestFileName = "bot.ts"
    private latestCode = ""
    private latestVersion = 1

    private latestCompleteId = 0
    private latestHoverId = 0
    private latestDetailsId = 0
    private latestDiagnosticsId = 0

    private readonly pendingCompletes = new Map<number, PendingResolver<CompletionResponse | null>>()
    private readonly pendingDetails = new Map<number, PendingResolver<TsCompletionDetails | null>>()
    private readonly pendingHovers = new Map<number, PendingResolver<TsQuickInfo | null>>()
    private readonly diagnosticsListeners = new Set<DiagnosticsListener>()
    private readonly statusListeners = new Set<StatusListener>()
    private diagnosticsTimer: number | undefined

    getStatus(): TsClientStatus {
        return this.status
    }

    isReady(): boolean {
        return this.status.state === "ready"
    }

    subscribeStatus(listener: StatusListener): () => void {
        this.statusListeners.add(listener)
        listener(this.status)
        return () => {
            this.statusListeners.delete(listener)
        }
    }

    subscribeDiagnostics(listener: DiagnosticsListener): () => void {
        this.diagnosticsListeners.add(listener)
        return () => {
            this.diagnosticsListeners.delete(listener)
        }
    }

    private setStatus(next: TsClientStatus): void {
        this.status = next
        for (const listener of this.statusListeners) listener(next)
    }

    private failAllPending(): void {
        for (const resolver of this.pendingCompletes.values()) resolver.resolve(null)
        this.pendingCompletes.clear()
        for (const resolver of this.pendingDetails.values()) resolver.resolve(null)
        this.pendingDetails.clear()
        for (const resolver of this.pendingHovers.values()) resolver.resolve(null)
        this.pendingHovers.clear()
    }

    private teardownCurrentWorker(): void {
        if (this.bootAbort) {
            this.bootAbort.abort()
            this.bootAbort = null
        }
        if (this.worker) {
            this.worker.terminate()
            this.worker = null
        }
        if (this.diagnosticsTimer !== undefined) {
            window.clearTimeout(this.diagnosticsTimer)
            this.diagnosticsTimer = undefined
        }
    }

    ensureStarted(fileName: string, code: string): Promise<boolean> {
        if (this.status.state === "ready") {
            if (fileName !== this.latestFileName || code !== this.latestCode) {
                this.updateDocument(fileName, code, true)
            }
            return Promise.resolve(true)
        }
        const changed = fileName !== this.latestFileName || code !== this.latestCode
        this.latestFileName = fileName
        this.latestCode = code
        if (changed) this.latestVersion += 1

        if (this.bootPromise) return this.bootPromise
        if (typeof window === "undefined" || typeof Worker === "undefined") {
            return Promise.resolve(false)
        }
        // Prevent offline or 404 retry storms on every keystroke or hover
        if (this.consecutiveFailures >= maxAutoFailures || Date.now() < this.nextRetryAt) {
            return Promise.resolve(false)
        }

        const token = ++this.bootToken
        this.setStatus({ state: "loading" })
        this.bootPromise = this.bootWithManifestRefresh(token).catch((error: unknown) => {
            if (token !== this.bootToken) return false
            const message = error instanceof Error ? error.message : String(error)
            console.error("Playground TypeScript IntelliSense failed to start:", error)
            this.consecutiveFailures += 1
            this.nextRetryAt = Date.now() + retryCooldownMs * this.consecutiveFailures
            this.teardownCurrentWorker()
            this.failAllPending()
            this.setStatus({ state: "error", message })
            this.bootPromise = null
            return false
        })
        return this.bootPromise
    }

    private async fetchManifest(signal: AbortSignal, forceReload: boolean): Promise<TsAssetManifest> {
        const response = await fetch("/playground/ts-manifest.json", {
            signal,
            cache: forceReload ? "reload" : "no-cache",
        })
        if (!response.ok) {
            throw new Error(`Could not load TypeScript manifest (HTTP ${response.status})`)
        }
        const manifest = (await response.json()) as TsAssetManifest
        if (!manifest.workerUrl || !manifest.coreTypesUrl || !manifest.effectTypesUrl) {
            throw new Error("TypeScript manifest is missing required asset URLs")
        }
        return manifest
    }

    private async bootWithManifestRefresh(token: number): Promise<boolean> {
        try {
            return await this.bootWorker(token, false)
        } catch (firstError) {
            if (token !== this.bootToken) return false
            // If a deploy rotated hashed assets right after manifest load, reload the manifest once and retry
            return await this.bootWorker(token, true).catch(() => {
                throw firstError
            })
        }
    }

    private async bootWorker(token: number, forceManifestReload: boolean): Promise<boolean> {
        this.teardownCurrentWorker()
        const abort = new AbortController()
        this.bootAbort = abort

        const manifest = await this.fetchManifest(abort.signal, forceManifestReload)
        if (token !== this.bootToken) return false

        // Download Worker script and core type bundle in parallel so both arrive in one RTT
        const worker = new Worker(manifest.workerUrl)
        this.worker = worker
        const coreBufferPromise = fetch(manifest.coreTypesUrl, { signal: abort.signal }).then(async (response) => {
            if (!response.ok) throw new Error(`Could not load TypeScript types (HTTP ${response.status})`)
            return response.arrayBuffer()
        })

        return new Promise<boolean>((resolve, reject) => {
            let settled = false
            const isActive = () => token === this.bootToken && this.worker === worker
            const finish = (ok: boolean, error?: Error) => {
                if (settled) return
                settled = true
                if (error) reject(error)
                else resolve(ok)
            }

            worker.onerror = (event) => {
                if (!isActive()) return
                const msg = event.message || "TypeScript worker stopped unexpectedly"
                abort.abort()
                worker.terminate()
                this.worker = null
                this.failAllPending()
                if (!settled) {
                    finish(false, new Error(msg))
                } else {
                    console.error("Playground TypeScript worker error:", msg)
                    this.setStatus({ state: "error", message: msg })
                    this.bootPromise = null
                }
            }

            worker.onmessage = (event: MessageEvent<TsWorkerToMainMessage>) => {
                if (!isActive()) return
                const msg = event.data
                if (!msg || typeof msg !== "object") return

                if (msg.type === "ready") {
                    this.consecutiveFailures = 0
                    this.nextRetryAt = 0
                    this.setStatus({ state: "ready", bootMs: msg.bootMs, hasEffect: msg.hasEffect })
                    if (msg.fileName === this.latestFileName && msg.version === this.latestVersion) {
                        for (const listener of this.diagnosticsListeners) {
                            listener(msg.fileName, msg.version, msg.diagnostics)
                        }
                    } else {
                        // User edited or switched presets while the worker booted; sync latest document now
                        this.post({
                            type: "update",
                            fileName: this.latestFileName,
                            code: this.latestCode,
                            version: this.latestVersion,
                        })
                        this.requestDiagnosticsNow()
                    }
                    finish(true)
                    return
                }

                if (msg.type === "effectLoaded") {
                    if (this.status.state === "ready") {
                        this.setStatus({ ...this.status, hasEffect: true })
                    }
                    this.requestDiagnosticsNow()
                    return
                }

                if (msg.type === "error") {
                    console.error("Playground TypeScript worker reported error:", msg.message)
                    this.failAllPending()
                    if (!settled) {
                        abort.abort()
                        worker.terminate()
                        this.worker = null
                        finish(false, new Error(msg.message))
                    }
                    return
                }

                if (msg.type === "completeResult") {
                    const resolver = this.pendingCompletes.get(msg.id)
                    if (resolver) {
                        this.pendingCompletes.delete(msg.id)
                        resolver.resolve(
                            msg.id === this.latestCompleteId
                                ? { from: msg.from, to: msg.to, items: msg.items, isIncomplete: msg.isIncomplete }
                                : null,
                        )
                    }
                    return
                }

                if (msg.type === "completionDetailsResult") {
                    const resolver = this.pendingDetails.get(msg.id)
                    if (resolver) {
                        this.pendingDetails.delete(msg.id)
                        resolver.resolve(msg.id === this.latestDetailsId ? msg.details : null)
                    }
                    return
                }

                if (msg.type === "hoverResult") {
                    const resolver = this.pendingHovers.get(msg.id)
                    if (resolver) {
                        this.pendingHovers.delete(msg.id)
                        resolver.resolve(msg.id === this.latestHoverId ? msg.info : null)
                    }
                    return
                }

                if (msg.type === "diagnosticsResult") {
                    if (
                        msg.id !== this.latestDiagnosticsId ||
                        msg.version !== this.latestVersion ||
                        msg.fileName !== this.latestFileName
                    ) {
                        return
                    }
                    for (const listener of this.diagnosticsListeners) {
                        listener(msg.fileName, msg.version, msg.diagnostics)
                    }
                }
            }

            void coreBufferPromise.then(
                (coreBuffer) => {
                    if (!isActive()) return
                    worker.postMessage(
                        {
                            type: "init",
                            coreTypesUrl: manifest.coreTypesUrl,
                            effectTypesUrl: manifest.effectTypesUrl,
                            coreBuffer,
                            fileName: this.latestFileName,
                            code: this.latestCode,
                            version: this.latestVersion,
                        } satisfies MainToTsWorkerMessage,
                        [coreBuffer],
                    )
                },
                (error: unknown) => {
                    if (!isActive()) return
                    const msg = error instanceof Error ? error.message : String(error)
                    worker.terminate()
                    this.worker = null
                    this.failAllPending()
                    finish(false, error instanceof Error ? error : new Error(msg))
                },
            )
        })
    }

    private post(message: MainToTsWorkerMessage): void {
        this.worker?.postMessage(message)
    }

    updateDocument(fileName: string, code: string, immediateDiagnostics = false): void {
        const changed = fileName !== this.latestFileName || code !== this.latestCode
        this.latestFileName = fileName
        this.latestCode = code
        if (changed) this.latestVersion += 1

        if (this.status.state !== "ready") return
        if (!changed && !immediateDiagnostics) return

        if (changed) {
            this.post({
                type: "update",
                fileName: this.latestFileName,
                code: this.latestCode,
                version: this.latestVersion,
            })
        }

        if (this.diagnosticsTimer !== undefined) {
            window.clearTimeout(this.diagnosticsTimer)
            this.diagnosticsTimer = undefined
        }
        if (immediateDiagnostics) {
            this.requestDiagnosticsNow()
        } else {
            this.diagnosticsTimer = window.setTimeout(() => {
                this.diagnosticsTimer = undefined
                this.requestDiagnosticsNow()
            }, 220)
        }
    }

    private requestDiagnosticsNow(): void {
        if (this.status.state !== "ready") return
        const id = this.nextId++
        this.latestDiagnosticsId = id
        this.post({
            type: "diagnostics",
            id,
            fileName: this.latestFileName,
            version: this.latestVersion,
        })
    }

    complete(
        fileName: string,
        code: string,
        offset: number,
        triggerCharacter: string | undefined,
        explicit: boolean,
    ): Promise<CompletionResponse | null> {
        if (this.status.state !== "ready") {
            void this.ensureStarted(fileName, code)
            return Promise.resolve(null)
        }
        if (fileName !== this.latestFileName || code !== this.latestCode) {
            this.updateDocument(fileName, code, false)
        }
        // Cancel any superseded completion promise immediately so CodeMirror never renders stale results
        for (const resolver of this.pendingCompletes.values()) resolver.resolve(null)
        this.pendingCompletes.clear()

        const id = this.nextId++
        this.latestCompleteId = id
        return new Promise<CompletionResponse | null>((resolve) => {
            this.pendingCompletes.set(id, { resolve })
            this.post({ type: "complete", id, fileName, offset, triggerCharacter, explicit })
        })
    }

    completionDetails(fileName: string, offset: number, name: string, source?: string): Promise<TsCompletionDetails | null> {
        if (this.status.state !== "ready") return Promise.resolve(null)
        for (const resolver of this.pendingDetails.values()) resolver.resolve(null)
        this.pendingDetails.clear()

        const id = this.nextId++
        this.latestDetailsId = id
        return new Promise<TsCompletionDetails | null>((resolve) => {
            this.pendingDetails.set(id, { resolve })
            this.post({ type: "completionDetails", id, fileName, offset, name, source })
        })
    }

    hover(fileName: string, code: string, offset: number): Promise<TsQuickInfo | null> {
        if (this.status.state !== "ready") {
            void this.ensureStarted(fileName, code)
            return Promise.resolve(null)
        }
        if (fileName !== this.latestFileName || code !== this.latestCode) {
            this.updateDocument(fileName, code, false)
        }
        for (const resolver of this.pendingHovers.values()) resolver.resolve(null)
        this.pendingHovers.clear()

        const id = this.nextId++
        this.latestHoverId = id
        return new Promise<TsQuickInfo | null>((resolve) => {
            this.pendingHovers.set(id, { resolve })
            this.post({ type: "hover", id, fileName, offset })
        })
    }
}

export const playgroundTsClient = new PlaygroundTsClient()
