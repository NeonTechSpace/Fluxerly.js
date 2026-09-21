const originValue = process.env.FLUXERLY_SUPERVISOR_CHILD_OPTIONS_ORIGIN
const mode = process.env.FLUXERLY_SUPERVISOR_CHILD_OPTIONS_MODE
const variant = process.env.FLUXERLY_SUPERVISOR_CHILD_OPTIONS_VARIANT
const token = process.env.FLUXERLY_SUPERVISOR_CHILD_OPTIONS_TOKEN

if (
    typeof originValue !== "string" ||
    (mode !== "default" && mode !== "native") ||
    (variant !== "ordinary" && variant !== "inherited" && variant !== "non-enumerable") ||
    token !== "supervisor-child-options-token"
)
    throw new Error("Missing supervisor child options fixture settings")

const origin = new URL(originValue)
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/")
    throw new Error("Unexpected supervisor child options origin")

const nativeFetch = globalThis.fetch
const discovery = new URL("/.well-known/fluxer", origin)
const proof = new URL("/supervisor-child-options-proof", origin)

globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input))
    if (target.href !== discovery.href && target.href !== proof.href)
        throw new Error(`Supervisor child options denied fetch outside its selected loopback instance: ${target.href}`)
    return nativeFetch(input, init)
}

function clientOptions() {
    const instance = Object.freeze({ url: origin.href, allowInsecure: true })
    if (variant === "ordinary") return { instance }
    if (variant === "inherited") {
        class Settings {
            #instance = instance

            get instance() {
                return this.#instance
            }
        }
        return new Settings()
    }
    const settings = {}
    Object.defineProperty(settings, "instance", { value: instance, enumerable: false })
    return settings
}

function errorTag(error) {
    return typeof error === "object" && error !== null && typeof error._tag === "string" ? error._tag : "unknown"
}

async function report(value) {
    const target = new URL(proof)
    target.searchParams.set("mode", mode)
    target.searchParams.set("variant", variant)
    target.searchParams.set("outcome", value.outcome)
    if (value.outcome === "resolved") {
        target.searchParams.set("apiPublic", value.resolved.endpoints.apiPublic)
        target.searchParams.set("gateway", value.resolved.endpoints.gateway)
    } else target.searchParams.set("failure", value.failure)
    const response = await nativeFetch(target, { method: "GET", redirect: "error" })
    if (!response.ok) throw new Error("Supervisor child options proof was rejected")
}

if (mode === "default") {
    const { supervisor } = await import("@neontechspace/fluxerly")
    const result = await supervisor.child.run({
        token,
        clientOptions: clientOptions(),
        configure: async ({ client }) => {
            const resolved = await client.instance.resolve()
            if (resolved.isErr()) {
                await report({ outcome: "failed", failure: errorTag(resolved.error) })
                throw resolved.error
            }
            await report({ outcome: "resolved", resolved: resolved.value })
            await new Promise(() => {})
        },
    })
    if (result.isErr()) throw result.error
} else {
    const { Effect } = await import("effect")
    const { supervisor } = await import("@neontechspace/fluxerly/effect")
    const exit = await Effect.runPromiseExit(
        supervisor.child.run({
            token,
            clientOptions: clientOptions(),
            configure: ({ client }) =>
                client.instance.resolve().pipe(
                    Effect.tap((resolved) => Effect.promise(() => report({ outcome: "resolved", resolved }))),
                    Effect.tapError((error) =>
                        Effect.promise(() => report({ outcome: "failed", failure: errorTag(error) })),
                    ),
                    Effect.andThen(Effect.never),
                ),
        }),
    )
    if (exit._tag === "Failure") throw new Error("Native supervisor child options helper failed")
}
