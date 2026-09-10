const originValue = process.env.FLUXERLY_SUPERVISOR_FAILURE_ORIGIN
const mode = process.env.FLUXERLY_SUPERVISOR_FAILURE_MODE
const token = process.env.FLUXERLY_SUPERVISOR_FAILURE_TOKEN

if (
    typeof originValue !== "string" ||
    (mode !== "default" && mode !== "native") ||
    token !== "supervisor-child-failure-token"
)
    throw new Error("Missing supervisor child failure settings")

const origin = new URL(originValue)
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/")
    throw new Error("Unexpected supervisor child failure origin")

const discovery = new URL("/.well-known/fluxer", origin)
const listenerBaseline = Object.freeze({
    message: process.listenerCount("message"),
    disconnect: process.listenerCount("disconnect"),
})
const nativeFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input))
    if (target.href === discovery.href)
        return new Response(
            new ReadableStream({
                cancel() {
                    throw new Error("Test-owned discovery cleanup defect")
                },
            }),
            { status: 503 },
        )
    if (target.origin !== origin.origin) throw new Error("Supervisor child denied non-loopback fetch")
    return nativeFetch(input, init)
}

function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function defaultReasons() {
    try {
        const { SdkDefect, supervisor } = await import("@neontechspace/fluxerly")
        const outcome = await supervisor.child
            .run({
                token,
                clientOptions: {
                    instance: { url: origin.href, allowInsecure: true },
                    connection: { startupTimeoutMs: 5_000, maxStartupAttempts: 1 },
                },
                configure: () => undefined,
            })
            .then(
                () => undefined,
                (error) => error,
            )
        if (!(outcome instanceof SdkDefect)) return ["Unexpected"]
        return outcome.reasons.map((reason) => {
            if (reason.kind === "Defect") return "Defect"
            if (reason.kind === "Interruption") return "Interruption"
            return `Failure:${record(reason.failure) && typeof reason.failure._tag === "string" ? reason.failure._tag : "Unknown"}`
        })
    } catch {
        return ["Unexpected"]
    }
}

async function nativeReasons() {
    try {
        const { Effect, Exit } = await import("effect")
        const { supervisor } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            supervisor.child.run({
                token,
                clientOptions: {
                    instance: { url: origin.href, allowInsecure: true },
                    connection: { startupTimeoutMs: 5_000, maxStartupAttempts: 1 },
                },
                configure: () => Effect.void,
            }),
        )
        if (!Exit.isFailure(exit)) return ["Unexpected"]
        return exit.cause.reasons.map((reason) => {
            if (reason._tag === "Die") return "Defect"
            if (reason._tag !== "Fail") return "Interruption"
            return `Failure:${record(reason.error) && typeof reason.error._tag === "string" ? reason.error._tag : "Unknown"}`
        })
    } catch {
        return ["Unexpected"]
    }
}

const reasons = mode === "default" ? await defaultReasons() : await nativeReasons()
const listenerFinal = Object.freeze({
    message: process.listenerCount("message"),
    disconnect: process.listenerCount("disconnect"),
})
const proof = new URL("/supervisor-child-failure-proof", origin)
proof.searchParams.set("mode", mode)
for (const reason of reasons) proof.searchParams.append("reason", reason)
proof.searchParams.set("messageBefore", String(listenerBaseline.message))
proof.searchParams.set("messageAfter", String(listenerFinal.message))
proof.searchParams.set("disconnectBefore", String(listenerBaseline.disconnect))
proof.searchParams.set("disconnectAfter", String(listenerFinal.disconnect))
const response = await nativeFetch(proof, { method: "GET", redirect: "error" })
if (!response.ok) throw new Error("Supervisor child failure proof failed")
