// Browser shims for node:timers and node:timers/promises with Node-compatible .unref() handles
import { cancelImmediate, scheduleImmediate } from "./install-globals"

export interface TimerHandle {
    readonly id: number
    unref(): this
    ref(): this
    [Symbol.toPrimitive](): number
}

function wrapHandle(id: number): TimerHandle {
    return {
        id,
        unref() {
            return this
        },
        ref() {
            return this
        },
        [Symbol.toPrimitive]() {
            return id
        },
    }
}

function unwrapId(handle: unknown): number | undefined {
    if (typeof handle === "number") return handle
    if (typeof handle === "object" && handle !== null && "id" in handle && typeof (handle as { id: unknown }).id === "number")
        return (handle as { id: number }).id
    return undefined
}

export function setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): TimerHandle {
    const id = globalThis.setTimeout(callback, delay, ...args) as unknown as number
    return wrapHandle(id)
}

export function clearTimeout(handle: unknown): void {
    const id = unwrapId(handle)
    if (id !== undefined) globalThis.clearTimeout(id)
}

export function setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): TimerHandle {
    const id = globalThis.setInterval(callback, delay, ...args) as unknown as number
    return wrapHandle(id)
}

export function clearInterval(handle: unknown): void {
    const id = unwrapId(handle)
    if (id !== undefined) globalThis.clearInterval(id)
}

export function setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]): TimerHandle {
    return wrapHandle(scheduleImmediate(callback, ...args))
}

export function clearImmediate(handle: unknown): void {
    const id = unwrapId(handle)
    if (id !== undefined) cancelImmediate(id)
}

export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }
