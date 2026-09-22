// @ts-check

import { createClient } from "@neontechspace/fluxerly"

/** @typedef {import("@neontechspace/fluxerly").Subscription} Subscription */

export class CriticalWorkerStoppedError extends Error {
    /** @param {number} index */
    constructor(index) {
        super(`Critical worker ${index + 1} stopped before the bot`)
        this.name = "CriticalWorkerStoppedError"
        this.workerIndex = index
    }
}

/** @param {unknown[]} errors */
function throwFailures(errors) {
    const unique = [...new Set(errors)]
    if (unique.length === 1) throw unique[0]
    if (unique.length > 1) throw new AggregateError(unique, "Bot lifetime failed")
}

/**
 * Supervise one client run and every critical subscription until a signal, client closure or failure stops the bot
 *
 * @template {import("@neontechspace/fluxerly").MessageCore} M
 * @param {import("@neontechspace/fluxerly").Client<M>} client
 * @param {readonly Subscription[]} workers
 * @param {AbortSignal} [signal]
 */
export async function supervise(client, workers, signal) {
    const controller = new AbortController()
    let stopping = false
    /** @type {Promise<void> | undefined} */
    let shutdown

    const close = () =>
        (shutdown ??= Promise.resolve()
            .then(() => client.shutdown())
            .then((result) => {
                if (result.isErr()) throw result.error
            }))
    const stop = () => {
        stopping = true
        controller.abort()
        void close().catch(() => undefined)
    }
    const onSignal = () => stop()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    signal?.addEventListener("abort", stop, { once: true })

    try {
        if (signal?.aborted) {
            stop()
            const settled = await Promise.allSettled([close()])
            throwFailures(settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
            return
        }

        const run = Promise.resolve()
            .then(() => client.run({ signal: controller.signal }))
            .then((result) => {
                if (
                    result.isErr() &&
                    !(stopping && (result.error._tag === "CancelledError" || result.error._tag === "ClientClosedError"))
                )
                    throw result.error
            })
        const observed = workers.map((worker, index) =>
            Promise.resolve()
                .then(() => worker.waitForClose())
                .then((result) => {
                    if (result.isErr()) throw result.error
                    if (!stopping && client.state !== "Closing" && client.state !== "Closed")
                        throw new CriticalWorkerStoppedError(index)
                }),
        )
        const tasks = [run, ...observed]
        await Promise.race(
            tasks.map((task) =>
                task.then(
                    () => undefined,
                    () => undefined,
                ),
            ),
        )
        stop()
        const settled = await Promise.allSettled([...tasks, close()])
        throwFailures(settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
    } finally {
        signal?.removeEventListener("abort", stop)
        process.removeListener("SIGINT", onSignal)
        process.removeListener("SIGTERM", onSignal)
    }
}

/**
 * Create and supervise a bot. Install every critical handler before the gateway starts
 * Only returned subscriptions are supervised. No worker is restarted and unreturned callback promises remain application-owned
 *
 * @template {import("@neontechspace/fluxerly").MessageFields | undefined} [F=undefined]
 * @param {import("@neontechspace/fluxerly").ClientOptions<F>} options
 * @param {(client: import("@neontechspace/fluxerly").Client<import("@neontechspace/fluxerly").SelectedMessage<F>>) => readonly Subscription[]} install
 * @param {AbortSignal} [signal]
 */
export async function runBot(options, install, signal) {
    if (signal?.aborted) return
    const created = createClient(options)
    if (created.isErr()) throw created.error
    const client = created.value
    let workers
    try {
        workers = install(client)
        if (!Array.isArray(workers)) throw new TypeError("Bot installation must return an array of subscriptions")
    } catch (error) {
        const cleanup = Promise.resolve()
            .then(() => client.shutdown())
            .then((result) => {
                if (result.isErr()) throw result.error
            })
        const settled = await Promise.allSettled([Promise.reject(error), cleanup])
        throwFailures(settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
        return
    }
    return supervise(client, workers, signal)
}
