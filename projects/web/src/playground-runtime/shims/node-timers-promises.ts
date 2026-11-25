// Browser shim for node:timers/promises (setImmediate and setTimeout)
import { cancelImmediate, scheduleImmediate } from "./install-globals"

export function setImmediate<T = void>(value?: T, options?: { readonly signal?: AbortSignal }): Promise<T> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const id = scheduleImmediate(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve(value as T)
        })
        const onAbort = () => {
            cancelImmediate(id)
            reject(signal?.reason)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

export function setTimeout<T = void>(ms = 0, value?: T, options?: { readonly signal?: AbortSignal }): Promise<T> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const id = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve(value as T)
        }, ms)
        const onAbort = () => {
            globalThis.clearTimeout(id)
            reject(signal?.reason)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

export default { setImmediate, setTimeout }
