// Isolated iframe runtime for the Fluxerly.js browser SDK sandbox.
// Runs the real @neontechspace/fluxerly SDK and createTestBot in memory with zero network access
import "./shims/install-globals"
import { sdkMeta, setProcessOutputListener } from "./shims/install-globals"
import { inspect } from "./shims/node-util"
import * as fluxerly from "../../../sdk/dist/index.js"
import * as fluxerlyTesting from "../../../sdk/dist/testing.js"
import * as fluxerlyEffect from "../../../sdk/dist/effect.js"
import * as fluxerlyEffectTesting from "../../../sdk/dist/effect-testing.js"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import { transform } from "sucrase"
import type {
    ParentToSandboxMessage,
    SandboxBotReply,
    SandboxConsoleEntry,
    SandboxEmbed,
    SandboxErrorPayload,
    SandboxFaultKind,
    SandboxGatewayEntry,
    SandboxLogEntry,
    SandboxMode,
    SandboxRestEntry,
    SandboxTelemetry,
    SandboxToParentMessage,
} from "./protocol"

const bootStart = performance.now()

const effectNamespace = Object.freeze({
    Cause,
    Context,
    Duration,
    Effect,
    Exit,
    Layer,
    Schedule,
    Scope,
})

const gatewayOpNames: Readonly<Record<number, string>> = {
    0: "DISPATCH",
    1: "HEARTBEAT",
    2: "IDENTIFY",
    3: "PRESENCE_UPDATE",
    4: "VOICE_STATE_UPDATE",
    6: "RESUME",
    7: "RECONNECT",
    8: "REQUEST_GUILD_MEMBERS",
    9: "INVALID_SESSION",
    10: "HELLO",
    11: "HEARTBEAT_ACK",
    12: "GATEWAY_ERROR",
}

type DefaultTestBot = ReturnType<typeof fluxerlyTesting.createTestBot>
type DefaultTestClient = ReturnType<typeof fluxerlyTesting.createTestClient>

interface ActiveBotHandle {
    readonly kind: "default" | "effect"
    readonly botName: string
    readonly canSay: boolean
    readonly rest: DefaultTestBot["rest"]
    totalSendCount(): number
    say(content: string): Promise<readonly SandboxBotReply[]>
    disconnect(): Promise<void>
    telemetry(): SandboxTelemetry
    dispose(): Promise<void>
}

const maxConsoleEntriesPerRun = 100
const maxConsoleLineChars = 2_000

let activeHandle: ActiveBotHandle | undefined
let activeFaultRoute: { remove(): void } | undefined
let latestRunId = 0
let runConsoleCount = 0
let consoleSeq = 1
let runStartMs = performance.now()
let rejectedSendIndexes = new Set<number>()

const isWorkerScope = typeof (globalThis as { importScripts?: unknown }).importScripts === "function"

function post(message: SandboxToParentMessage): void {
    if (isWorkerScope) {
        ;(globalThis as unknown as { postMessage(payload: SandboxToParentMessage): void }).postMessage(message)
        return
    }
    globalThis.parent?.postMessage(message, "*")
}

function emitConsole(level: SandboxConsoleEntry["level"], parts: readonly unknown[], expectedRunId?: number): void {
    if (expectedRunId !== undefined && expectedRunId !== latestRunId) return
    const runId = expectedRunId ?? latestRunId
    runConsoleCount += 1
    if (runConsoleCount > maxConsoleEntriesPerRun + 1) return
    if (runConsoleCount === maxConsoleEntriesPerRun + 1) {
        post({
            type: "console",
            runId,
            entry: {
                id: consoleSeq++,
                level: "warn",
                text: `Console output truncated after ${maxConsoleEntriesPerRun} lines`,
                timeMs: Math.round((performance.now() - runStartMs) * 10) / 10,
            },
        })
        return
    }
    const rawText = parts
        .map((part) => {
            if (typeof part === "string") return part
            if (part instanceof Error) return fluxerly.describeError(part)
            return inspect(part, { depth: 4 })
        })
        .join(" ")
    const text = rawText.length > maxConsoleLineChars ? `${rawText.slice(0, maxConsoleLineChars - 3)}...` : rawText
    post({
        type: "console",
        runId,
        entry: {
            id: consoleSeq++,
            level,
            text,
            timeMs: Math.round((performance.now() - runStartMs) * 10) / 10,
        },
    })
}

setProcessOutputListener((stream, chunk) => {
    const trimmed = chunk.trimEnd()
    if (!trimmed) return
    emitConsole(stream === "stderr" ? "error" : "log", [trimmed])
})

function emptyTelemetry(): SandboxTelemetry {
    return {
        logs: [],
        requests: [],
        gateway: [],
        counters: {
            restRetries: 0,
            rateLimitWaits: 0,
            reconnects: 0,
            resumes: 0,
            commandRejections: 0,
            handlerFailures: 0,
        },
        failures: 0,
    }
}

function safeJsonPreview(value: unknown): string | undefined {
    if (value === undefined) return undefined
    try {
        const text = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
        return text.length > 260 ? `${text.slice(0, 257)}...` : text
    } catch {
        return inspect(value, { depth: 2 })
    }
}

function serializeEmbed(raw: unknown): SandboxEmbed | undefined {
    if (typeof raw !== "object" || raw === null) return undefined
    const item = raw as Record<string, unknown>
    const author = typeof item.author === "object" && item.author !== null ? (item.author as Record<string, unknown>) : undefined
    const footer = typeof item.footer === "object" && item.footer !== null ? (item.footer as Record<string, unknown>) : undefined
    const fields = Array.isArray(item.fields)
        ? item.fields
              .filter((field): field is Record<string, unknown> => typeof field === "object" && field !== null)
              .map((field) => ({
                  name: typeof field.name === "string" ? field.name : "",
                  value: typeof field.value === "string" ? field.value : "",
                  inline: field.inline === true,
              }))
        : []
    return {
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.url === "string" ? { url: item.url } : {}),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(typeof item.color === "number" ? { color: item.color } : {}),
        ...(typeof author?.name === "string" ? { authorName: author.name } : {}),
        ...(typeof footer?.text === "string" ? { footerText: footer.text } : {}),
        ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}),
        fields,
    }
}

function serializeReply(message: unknown, fallbackAuthor: string): SandboxBotReply {
    const raw = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>
    const author = typeof raw.author === "object" && raw.author !== null ? (raw.author as Record<string, unknown>) : undefined
    const embeds = Array.isArray(raw.embeds)
        ? raw.embeds.map(serializeEmbed).filter((embed): embed is SandboxEmbed => embed !== undefined)
        : []
    return {
        id: typeof raw.id === "string" ? raw.id : String(Math.random()),
        author: typeof author?.username === "string" ? author.username : fallbackAuthor,
        content: typeof raw.content === "string" ? raw.content : "",
        embeds,
    }
}

function collectTelemetry(source: {
    logs(): readonly unknown[]
    requests(): readonly unknown[]
    commands(): readonly unknown[]
    counters(): Record<string, unknown>
    failures(): readonly unknown[]
}): SandboxTelemetry {
    const logs: SandboxLogEntry[] = source
        .logs()
        .slice(-80)
        .map((item) => {
            const entry = item as Record<string, unknown>
            const error = typeof entry.error === "object" && entry.error !== null ? (entry.error as Record<string, unknown>) : undefined
            return {
                time: typeof entry.time === "number" ? entry.time : Date.now(),
                level: typeof entry.level === "string" ? entry.level : "info",
                category: typeof entry.category === "string" ? entry.category : "sdk",
                code: typeof entry.code === "string" ? entry.code : "",
                message: typeof entry.message === "string" ? entry.message : "",
                ...(typeof entry.route === "string" ? { route: entry.route } : {}),
                ...(typeof entry.status === "number" ? { status: entry.status } : {}),
                ...(typeof entry.delayMs === "number" ? { delayMs: entry.delayMs } : {}),
                ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
                ...(typeof entry.event === "string" ? { event: entry.event } : {}),
                ...(typeof entry.command === "string" ? { command: entry.command } : {}),
                ...(typeof error?.name === "string" ? { errorName: error.name } : {}),
                ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
                ...(typeof error?.message === "string" ? { errorMessage: error.message } : {}),
                ...(typeof error?.hint === "string" ? { errorHint: error.hint } : {}),
            }
        })

    const requests: SandboxRestEntry[] = source
        .requests()
        .slice(-80)
        .map((item, index) => {
            const req = item as Record<string, unknown>
            const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : undefined
            return {
                index: index + 1,
                method: typeof req.method === "string" ? req.method : "GET",
                path: typeof req.path === "string" ? req.path : "/",
                matched: req.matched === true,
                bodyPreview: safeJsonPreview(req.body),
                ...(typeof body?.content === "string" ? { content: body.content } : {}),
                hasEmbeds: Array.isArray(body?.embeds) && body.embeds.length > 0,
            }
        })

    const gateway: SandboxGatewayEntry[] = source
        .commands()
        .slice(-60)
        .map((item, index) => {
            const cmd = item as Record<string, unknown>
            const op = typeof cmd.op === "number" ? cmd.op : -1
            return {
                index: index + 1,
                op,
                opName: gatewayOpNames[op] ?? `OP_${op}`,
                shardId: typeof cmd.shardId === "number" ? cmd.shardId : null,
                summary: safeJsonPreview(cmd.d) ?? "null",
            }
        })

    const rawCounters = source.counters()
    const num = (key: string) => (typeof rawCounters[key] === "number" ? (rawCounters[key] as number) : 0)
    return {
        logs,
        requests,
        gateway,
        counters: {
            restRetries: num("restRetries"),
            rateLimitWaits: num("rateLimitWaits"),
            reconnects: num("reconnects"),
            resumes: num("resumes"),
            commandRejections: num("commandRejections"),
            handlerFailures: num("handlerFailures"),
        },
        failures: source.failures().length,
    }
}

function serializeError(error: unknown): SandboxErrorPayload {
    if (error instanceof Error) {
        const loc = (error as { loc?: { line?: number; column?: number } }).loc
        return {
            name: error.name || "Error",
            message: error instanceof fluxerly.FluxerlyError ? fluxerly.describeError(error) : error.message,
            ...(typeof loc?.line === "number" ? { line: loc.line } : {}),
            ...(typeof loc?.column === "number" ? { column: loc.column } : {}),
            ...(typeof error.stack === "string" ? { stack: error.stack.split("\n").slice(0, 6).join("\n") } : {}),
        }
    }
    return { name: "Error", message: String(error) }
}

async function disposeActive(): Promise<void> {
    activeFaultRoute?.remove()
    activeFaultRoute = undefined
    const current = activeHandle
    activeHandle = undefined
    if (!current) return
    try {
        await current.dispose()
    } catch {
        // Ignore shutdown errors from previous sandbox runs
    }
}

async function waitForGatewayRecovery(
    getCounters: () => { readonly resumes: number; readonly reconnects: number },
    beforeResumes: number,
    beforeReconnects: number,
): Promise<void> {
    const deadline = performance.now() + 4_000
    while (performance.now() < deadline) {
        const current = getCounters()
        if (current.resumes > beforeResumes || current.reconnects > beforeReconnects) return
        await new Promise((resolve) => globalThis.setTimeout(resolve, 40))
    }
}

function wrapDefaultTestBot(bot: DefaultTestBot): ActiveBotHandle {
    const botName = bot.fixtures.botUser().username ?? "fluxerly-bot"
    const countSends = () => bot.requests().filter((req) => req.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(req.path)).length
    return {
        kind: "default",
        botName,
        canSay: typeof bot.say === "function",
        rest: bot.rest,
        totalSendCount: countSends,
        async say(content: string) {
            const beforeSendCount = countSends()
            const replies = await bot.say(content, { timeoutMs: 8_000 })
            return replies
                .filter((_message, offset) => !rejectedSendIndexes.has(beforeSendCount + offset))
                .map((message) => serializeReply(message, botName))
        },
        async disconnect() {
            const before = bot.counters()
            bot.disconnect({ code: 4000 })
            await waitForGatewayRecovery(() => bot.counters(), before.resumes, before.reconnects)
            await bot.idle({ timeoutMs: 5_000 })
        },
        telemetry() {
            return collectTelemetry({
                logs: () => bot.logs(),
                requests: () => bot.requests(),
                commands: () => bot.commands(),
                counters: () => bot.counters() as unknown as Record<string, unknown>,
                failures: () => bot.failures(),
            })
        },
        async dispose() {
            // Read failures so UnhandledTestFailuresError does not disrupt sandbox teardown
            bot.failures()
            await bot.shutdown()
        },
    }
}

async function bootEffectBot(options: Record<string, unknown>): Promise<ActiveBotHandle> {
    const scope = Scope.makeUnsafe()
    const mergedOptions = {
        ...options,
        logging: {
            level: "debug",
            ...(typeof options.logging === "object" && options.logging !== null ? (options.logging as Record<string, unknown>) : {}),
        },
    }
    try {
        const bot = await Effect.runPromise(
            fluxerlyEffectTesting.createTestBot(mergedOptions as never).pipe(Scope.provide(scope)) as unknown as Effect.Effect<
                {
                    readonly fixtures: DefaultTestBot["fixtures"]
                    readonly rest: DefaultTestBot["rest"]
                    ready(): Effect.Effect<void, unknown>
                    say(content: string, options?: { timeoutMs?: number }): Effect.Effect<readonly unknown[], unknown>
                    disconnect(options?: { code?: number }): Effect.Effect<void, unknown>
                    idle(options?: { timeoutMs?: number }): Effect.Effect<void, unknown>
                    logs(): readonly unknown[]
                    requests(): readonly { readonly method: string; readonly path: string }[]
                    commands(): readonly unknown[]
                    counters(): { readonly resumes: number; readonly reconnects: number } & Record<string, unknown>
                    failures(): readonly unknown[]
                },
                unknown
            >,
        )
        await Effect.runPromise(bot.ready())
        const botName = bot.fixtures.botUser().username ?? "fluxerly-bot"
        const countSends = () =>
            bot.requests().filter((req: { readonly method: string; readonly path: string }) => req.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(req.path))
                .length
        return {
            kind: "effect",
            botName,
            canSay: true,
            rest: bot.rest,
            totalSendCount: countSends,
            async say(content: string) {
                const beforeSendCount = countSends()
                const replies = await Effect.runPromise(bot.say(content, { timeoutMs: 8_000 }))
                return replies
                    .filter((_message: unknown, offset: number) => !rejectedSendIndexes.has(beforeSendCount + offset))
                    .map((message: unknown) => serializeReply(message, botName))
            },
            async disconnect() {
                const before = bot.counters()
                await Effect.runPromise(bot.disconnect({ code: 4000 }))
                await waitForGatewayRecovery(() => bot.counters(), before.resumes, before.reconnects)
                await Effect.runPromise(bot.idle({ timeoutMs: 5_000 }))
            },
            telemetry() {
                return collectTelemetry({
                    logs: () => bot.logs(),
                    requests: () => bot.requests(),
                    commands: () => bot.commands(),
                    counters: () => bot.counters(),
                    failures: () => bot.failures(),
                })
            },
            async dispose() {
                bot.failures()
                await Effect.runPromise(Scope.close(scope, Exit.void))
            },
        }
    } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {})
        throw error
    }
}

function isTestClientLike(value: unknown): value is DefaultTestBot | DefaultTestClient {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { ready?: unknown }).ready === "function" &&
        typeof (value as { shutdown?: unknown }).shutdown === "function" &&
        typeof (value as { rest?: unknown }).rest === "object"
    )
}

function isBotConfigLike(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return "commands" in record || "events" in record || "setup" in record || "cache" in record
}

async function disposeBots(bots: readonly DefaultTestBot[], extra?: ActiveBotHandle): Promise<void> {
    if (extra) {
        try {
            await extra.dispose()
        } catch {
            // Ignore shutdown errors from superseded runs
        }
    }
    for (const bot of bots) {
        try {
            bot.failures()
            await bot.shutdown()
        } catch {
            // Ignore already-shut-down bots
        }
    }
}

async function handleRun(runId: number, code: string, mode: SandboxMode): Promise<void> {
    latestRunId = runId
    const isStale = () => runId !== latestRunId
    runConsoleCount = 0
    await disposeActive()
    if (isStale()) return
    rejectedSendIndexes = new Set<number>()
    runStartMs = performance.now()
    let compileMs = 0

    // Replace import.meta.main so starter snippets pasted from docs never try to open a real network socket
    const prepared = code.replaceAll("import.meta.main", "false")

    let compiled: string
    const compileStart = performance.now()
    try {
        compiled = transform(prepared, {
            transforms: ["typescript", "imports"],
            disableESTransforms: true,
        }).code
        compileMs = Math.round((performance.now() - compileStart) * 10) / 10
    } catch (error) {
        compileMs = Math.round((performance.now() - compileStart) * 10) / 10
        if (isStale()) return
        post({
            type: "runResult",
            runId,
            ok: false,
            compileMs,
            runMs: 0,
            interactive: false,
            botName: "fluxerly-bot",
            telemetry: emptyTelemetry(),
            error: serializeError(error),
        })
        return
    }

    const trackedBots: DefaultTestBot[] = []
    let usedEffectImport = mode === "effect"

    const sandboxTesting = Object.freeze({
        ...fluxerlyTesting,
        createTestBot: ((options: Parameters<typeof fluxerlyTesting.createTestBot>[0]) => {
            const bot = fluxerlyTesting.createTestBot({
                ...options,
                logging: {
                    level: "debug",
                    ...options?.logging,
                },
            })
            trackedBots.push(bot)
            return bot
        }) as typeof fluxerlyTesting.createTestBot,
    })

    const moduleMap = new Map<string, unknown>([
        ["@neontechspace/fluxerly", fluxerly],
        ["@neontechspace/fluxerly/testing", sandboxTesting],
        ["@neontechspace/fluxerly/effect", fluxerlyEffect],
        ["@neontechspace/fluxerly/effect/testing", fluxerlyEffectTesting],
        ["effect", effectNamespace],
        ["effect/Effect", Effect],
        ["effect/Cause", Cause],
        ["effect/Context", Context],
        ["effect/Duration", Duration],
        ["effect/Exit", Exit],
        ["effect/Layer", Layer],
        ["effect/Schedule", Schedule],
        ["effect/Scope", Scope],
    ])

    const sandboxRequire = (specifier: string): unknown => {
        if (specifier === "@neontechspace/fluxerly/effect" || specifier === "@neontechspace/fluxerly/effect/testing" || specifier === "effect" || specifier.startsWith("effect/")) {
            usedEffectImport = true
        }
        if (moduleMap.has(specifier)) return moduleMap.get(specifier)
        throw new Error(
            `Module "${specifier}" is not available in the offline browser sandbox. Supported imports: @neontechspace/fluxerly, @neontechspace/fluxerly/testing, @neontechspace/fluxerly/effect, @neontechspace/fluxerly/effect/testing, effect`,
        )
    }

    const sandboxConsole = {
        log: (...args: unknown[]) => emitConsole("log", args, runId),
        info: (...args: unknown[]) => emitConsole("info", args, runId),
        warn: (...args: unknown[]) => emitConsole("warn", args, runId),
        error: (...args: unknown[]) => emitConsole("error", args, runId),
        dir: (...args: unknown[]) => emitConsole("log", args, runId),
    }

    const mod: { exports: Record<string, unknown> } = { exports: {} }
    const execStart = performance.now()
    let nextHandle: ActiveBotHandle | undefined
    try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
            ...args: string[]
        ) => (
            req: (id: string) => unknown,
            exp: Record<string, unknown>,
            m: { exports: Record<string, unknown> },
            con: typeof sandboxConsole,
        ) => Promise<void>
        const fn = new AsyncFunction("require", "exports", "module", "console", compiled)
        await fn(sandboxRequire, mod.exports, mod, sandboxConsole)
        if (isStale()) {
            await disposeBots(trackedBots)
            return
        }

        const candidate = mod.exports.default ?? mod.exports.bot
        if (isTestClientLike(candidate)) {
            await candidate.ready()
            nextHandle = wrapDefaultTestBot(candidate as DefaultTestBot)
        } else if (isBotConfigLike(candidate)) {
            if (usedEffectImport) {
                nextHandle = await bootEffectBot(candidate)
            } else {
                const bot = fluxerlyTesting.createTestBot({
                    ...candidate,
                    logging: {
                        level: "debug",
                        ...(typeof candidate.logging === "object" && candidate.logging !== null
                            ? (candidate.logging as Record<string, unknown>)
                            : {}),
                    },
                } as Parameters<typeof fluxerlyTesting.createTestBot>[0])
                trackedBots.push(bot)
                await bot.ready()
                nextHandle = wrapDefaultTestBot(bot)
            }
        } else if (trackedBots.length > 0) {
            const lastBot = trackedBots[trackedBots.length - 1]!
            try {
                await lastBot.ready()
            } catch {
                // Already shut down by user script; keep telemetry readable
            }
            nextHandle = wrapDefaultTestBot(lastBot)
        }

        if (isStale()) {
            await disposeBots(trackedBots, nextHandle)
            return
        }

        activeHandle = nextHandle
        const runMs = Math.round((performance.now() - execStart) * 10) / 10
        post({
            type: "runResult",
            runId,
            ok: true,
            compileMs,
            runMs,
            interactive: Boolean(activeHandle?.canSay),
            botName: activeHandle?.botName ?? "fluxerly-bot",
            telemetry: activeHandle ? activeHandle.telemetry() : emptyTelemetry(),
        })
    } catch (error) {
        const telemetry = nextHandle
            ? nextHandle.telemetry()
            : trackedBots.length > 0
              ? wrapDefaultTestBot(trackedBots[trackedBots.length - 1]!).telemetry()
              : emptyTelemetry()
        await disposeBots(trackedBots, nextHandle)
        if (isStale()) return
        const runMs = Math.round((performance.now() - execStart) * 10) / 10
        post({
            type: "runResult",
            runId,
            ok: false,
            compileMs,
            runMs,
            interactive: false,
            botName: "fluxerly-bot",
            telemetry,
            error: serializeError(error),
        })
    }
}

async function handleSay(requestId: number, content: string): Promise<void> {
    const handle = activeHandle
    if (!handle) {
        post({
            type: "sayResult",
            requestId,
            ok: false,
            durationMs: 0,
            replies: [],
            telemetry: emptyTelemetry(),
            error: { name: "SandboxError", message: "No active bot is running. Export a defineBot config or click Run first" },
        })
        return
    }
    const start = performance.now()
    try {
        const replies = await handle.say(content)
        if (activeHandle !== handle) return
        const durationMs = Math.round((performance.now() - start) * 10) / 10
        post({
            type: "sayResult",
            requestId,
            ok: true,
            durationMs,
            replies,
            telemetry: handle.telemetry(),
        })
    } catch (error) {
        if (activeHandle !== handle) return
        const durationMs = Math.round((performance.now() - start) * 10) / 10
        post({
            type: "sayResult",
            requestId,
            ok: false,
            durationMs,
            replies: [],
            telemetry: handle.telemetry(),
            error: serializeError(error),
        })
    }
}

async function handleFault(requestId: number, fault: SandboxFaultKind): Promise<void> {
    const handle = activeHandle
    if (!handle) {
        post({
            type: "faultResult",
            requestId,
            ok: false,
            fault,
            note: "No active bot is running",
            telemetry: emptyTelemetry(),
        })
        return
    }
    try {
        if (fault === "disconnect") {
            await handle.disconnect()
            if (activeHandle !== handle) return
            post({
                type: "faultResult",
                requestId,
                ok: true,
                fault,
                note: "Dropped shard 0 with close code 4000. Fluxerly resumed the session cleanly",
                telemetry: handle.telemetry(),
            })
            return
        }

        activeFaultRoute?.remove()
        const route = handle.rest.respond("POST /channels/:id/messages", () => {
            route.remove()
            if (activeFaultRoute === route) activeFaultRoute = undefined
            // Use the unsliced REST count so rejected indexes stay aligned with say() after 80+ requests
            const sendCount = handle.totalSendCount()
            if (sendCount > 0) rejectedSendIndexes.add(sendCount - 1)
            if (fault === "429") {
                return {
                    status: 429,
                    headers: { "retry-after": "0.35" },
                    body: { code: "RATE_LIMITED", message: "You are being rate limited", retry_after: 0.35 },
                }
            }
            if (fault === "403") {
                return {
                    status: 403,
                    body: { code: "MISSING_PERMISSIONS", message: "Missing Permissions" },
                }
            }
            return {
                status: 404,
                body: { code: "UNKNOWN_CHANNEL", message: "Unknown Channel" },
            }
        })
        activeFaultRoute = route

        const note =
            fault === "429"
                ? "Armed next reply with HTTP 429 (Retry-After: 0.35s). Send a command to watch automatic rate-limit recovery"
                : fault === "403"
                  ? "Armed next reply with HTTP 403 Missing Permissions. Send a command to inspect the typed Result error"
                  : "Armed next reply with HTTP 404 Unknown Channel. Send a command to inspect the typed Result error"

        post({
            type: "faultResult",
            requestId,
            ok: true,
            fault,
            note,
            telemetry: handle.telemetry(),
        })
    } catch (error) {
        if (activeHandle !== handle) return
        post({
            type: "faultResult",
            requestId,
            ok: false,
            fault,
            note: "Failed to inject fault",
            telemetry: handle.telemetry(),
            error: serializeError(error),
        })
    }
}

globalThis.addEventListener("message", (event: MessageEvent<ParentToSandboxMessage>) => {
    if (!isWorkerScope && event.source !== undefined && event.source !== globalThis.parent) return
    const data = event.data
    if (!data || typeof data !== "object") return
    if (data.type === "run") {
        void handleRun(data.runId, data.code, data.mode)
    } else if (data.type === "say") {
        void handleSay(data.requestId, data.content)
    } else if (data.type === "fault") {
        void handleFault(data.requestId, data.fault)
    } else if (data.type === "dispose") {
        latestRunId += 1
        void disposeActive()
    }
})

post({
    type: "booted",
    bootMs: Math.round((performance.now() - bootStart) * 10) / 10,
    sdkVersion: sdkMeta.version,
})
