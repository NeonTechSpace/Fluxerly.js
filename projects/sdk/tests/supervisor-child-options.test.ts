import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import { supervisor as defaultSupervisor } from "../src/index.js"
import { supervisor as nativeSupervisor } from "../src/effect.js"
import type { SupervisorOptions, SupervisorStatus } from "../src/supervisor.js"

type Mode = "default" | "native"
type Variant = "ordinary" | "inherited" | "non-enumerable"
type Proof = {
    readonly mode: Mode
    readonly variant: Variant
    readonly outcome: "resolved" | "failed"
    readonly apiPublic?: string
    readonly gateway?: string
    readonly failure?: string
}
type Managed = {
    start(): Promise<void>
    shutdown(): Promise<void>
    waitForClose(): Promise<void>
    status(): SupervisorStatus
}

function document(origin: string) {
    return {
        api_code_version: 1,
        endpoints: {
            api_public: `${origin}/selected-api`,
            gateway: `${origin.replace("http:", "ws:")}/selected-gateway`,
            media: `${origin}/selected-media`,
            static_cdn: `${origin}/selected-static`,
            webapp: `${origin}/selected-webapp`,
            invite: `${origin}/selected-invite`,
        },
        features: { presigned_attachment_uploads: false },
    }
}

async function selectedInstanceFixture() {
    let origin = ""
    let closed = false
    const discoveries: string[] = []
    const proofs: Proof[] = []
    const server = createServer((request, response) => {
        const target = new URL(request.url ?? "/", origin)
        if (target.pathname === "/.well-known/fluxer") {
            if (request.method !== "GET" || request.headers.authorization !== undefined) {
                response.statusCode = 400
                response.end()
                return
            }
            discoveries.push(target.href)
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify(document(origin)))
            return
        }
        if (target.pathname === "/supervisor-child-options-proof") {
            const mode = target.searchParams.get("mode")
            const variant = target.searchParams.get("variant")
            const outcome = target.searchParams.get("outcome")
            const apiPublic = target.searchParams.get("apiPublic")
            const gateway = target.searchParams.get("gateway")
            if (
                (mode !== "default" && mode !== "native") ||
                (variant !== "ordinary" && variant !== "inherited" && variant !== "non-enumerable") ||
                (outcome !== "resolved" && outcome !== "failed") ||
                (outcome === "resolved" &&
                    (apiPublic !== `${origin}/selected-api` ||
                        gateway !== `${origin.replace("http:", "ws:")}/selected-gateway`)) ||
                (outcome === "failed" && typeof target.searchParams.get("failure") !== "string")
            ) {
                response.statusCode = 400
                response.end()
                return
            }
            proofs.push(
                outcome === "resolved"
                    ? { mode, variant, outcome, apiPublic: apiPublic!, gateway: gateway! }
                    : { mode, variant, outcome, failure: target.searchParams.get("failure")! },
            )
            response.statusCode = 204
            response.end()
            return
        }
        response.statusCode = 404
        response.end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing supervisor child options address")
    origin = `http://127.0.0.1:${address.port}`
    return {
        origin,
        discoveries,
        proofs,
        async close() {
            if (closed) return
            closed = true
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

async function managed(mode: Mode, origin: string, variant: Variant): Promise<Managed> {
    const worker = new URL("./supervisor-child-options-worker.mjs", import.meta.url)
    const options: SupervisorOptions = {
        entry: mode === "default" ? fileURLToPath(worker) : worker,
        totalShards: 1,
        assignments: [{ id: "selected-instance", shardIds: [0] }],
        startupTimeoutMs: 5_000,
        shutdownTimeoutMs: 1_000,
        childEnvironment: {
            FLUXERLY_SUPERVISOR_CHILD_OPTIONS_ORIGIN: origin,
            FLUXERLY_SUPERVISOR_CHILD_OPTIONS_MODE: mode,
            FLUXERLY_SUPERVISOR_CHILD_OPTIONS_VARIANT: variant,
            FLUXERLY_SUPERVISOR_CHILD_OPTIONS_TOKEN: "supervisor-child-options-token",
        },
    }
    if (mode === "default") {
        const created = defaultSupervisor.create(options)
        if (created.isErr()) throw created.error
        return {
            async start() {
                const started = await created.value.start()
                if (started.isErr()) throw started.error
            },
            async shutdown() {
                const result = await created.value.shutdown()
                if (result.isErr()) throw result.error
            },
            async waitForClose() {
                const result = await created.value.waitForClose()
                if (result.isErr()) throw result.error
            },
            status: () => created.value.status(),
        }
    }
    const created = await Effect.runPromise(nativeSupervisor.create(options))
    return {
        start: () => Effect.runPromise(created.start()),
        shutdown: () => Effect.runPromise(created.shutdown()),
        waitForClose: () => Effect.runPromise(created.waitForClose()),
        status: () => created.status(),
    }
}

function childOverride(field: "token" | "sharding", inherited: boolean) {
    const options = {}
    Object.defineProperty(options, field, {
        value: field === "token" ? "override-token" : { totalShards: 1, shardIds: [0] },
        enumerable: false,
    })
    return inherited ? Object.create(options) : options
}

test.each(
    (["default", "native"] as const).flatMap((mode) =>
        (["token", "sharding"] as const).flatMap((field) =>
            [false, true].map((inherited) => [mode, field, inherited] as const),
        ),
    ),
)("%s public child helper rejects %s override before IPC (inherited: %s)", async (mode, field, inherited) => {
    if (mode === "default") {
        const configure = vi.fn()
        const result = await defaultSupervisor.child.run({
            token: "supervisor-child-options-token",
            clientOptions: childOverride(field, inherited) as never,
            configure,
        })
        expect(result.isErr()).toBe(true)
        if (result.isOk()) throw new Error("Expected child options override rejection")
        expect(result.error).toMatchObject({ _tag: "ConfigurationError", field: "configuration" })
        expect(configure).not.toHaveBeenCalled()
    } else {
        const configure = vi.fn(() => Effect.void)
        const exit = await Effect.runPromiseExit(
            nativeSupervisor.child.run({
                token: "supervisor-child-options-token",
                clientOptions: childOverride(field, inherited) as never,
                configure,
            }),
        )
        if (exit._tag !== "Failure") throw new Error("Expected child options override rejection")
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
            _tag: "ConfigurationError",
            field: "configuration",
        })
        expect(configure).not.toHaveBeenCalled()
    }
})

test.each(
    (["default", "native"] as const).flatMap((mode) =>
        (["ordinary", "inherited", "non-enumerable"] as const).map((variant) => [mode, variant] as const),
    ),
)(
    "%s public child helper retains %s selected instance settings",
    async (mode, variant) => {
        const fixture = await selectedInstanceFixture()
        let owner: Managed | undefined
        let cleaned = false
        const cleanup = async () => {
            if (cleaned) return
            cleaned = true
            try {
                await owner?.shutdown()
            } finally {
                await fixture.close()
            }
        }
        onTestFinished(cleanup)
        try {
            owner = await managed(mode, fixture.origin, variant)
            const active = owner
            const starting = active.start().catch(() => undefined)
            await vi.waitFor(() => expect(fixture.proofs).toHaveLength(1), { timeout: 5_000 })
            expect({ discoveries: fixture.discoveries, proofs: fixture.proofs }).toEqual({
                discoveries: [`${fixture.origin}/.well-known/fluxer`],
                proofs: [
                    {
                        mode,
                        variant,
                        outcome: "resolved",
                        apiPublic: `${fixture.origin}/selected-api`,
                        gateway: `${fixture.origin.replace("http:", "ws:")}/selected-gateway`,
                    },
                ],
            })
            await active.shutdown()
            await active.waitForClose()
            await starting
            expect(active.status()).toMatchObject({
                state: "closed",
                children: [{ id: "selected-instance", pid: null, state: "closed" }],
            })
        } finally {
            await cleanup()
        }
    },
    10_000,
)
