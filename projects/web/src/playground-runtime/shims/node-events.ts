// Minimal EventEmitter shim for @neontechspace/fluxerly's in-memory FakeSocket

type Listener = (...args: unknown[]) => void

interface Entry {
    readonly fn: Listener
    readonly once: boolean
}

export class EventEmitter {
    readonly #listeners = new Map<string | symbol, Entry[]>()

    setMaxListeners(): this {
        return this
    }

    on(event: string | symbol, fn: Listener): this {
        const list = this.#listeners.get(event) ?? []
        list.push({ fn, once: false })
        this.#listeners.set(event, list)
        return this
    }

    addListener(event: string | symbol, fn: Listener): this {
        return this.on(event, fn)
    }

    once(event: string | symbol, fn: Listener): this {
        const list = this.#listeners.get(event) ?? []
        list.push({ fn, once: true })
        this.#listeners.set(event, list)
        return this
    }

    off(event: string | symbol, fn: Listener): this {
        const list = this.#listeners.get(event)
        if (!list) return this
        const next = list.filter((item) => item.fn !== fn)
        if (next.length === 0) this.#listeners.delete(event)
        else this.#listeners.set(event, next)
        return this
    }

    removeListener(event: string | symbol, fn: Listener): this {
        return this.off(event, fn)
    }

    removeAllListeners(event?: string | symbol): this {
        if (event === undefined) this.#listeners.clear()
        else this.#listeners.delete(event)
        return this
    }

    emit(event: string | symbol, ...args: unknown[]): boolean {
        const list = this.#listeners.get(event)
        if (!list || list.length === 0) return false
        const snapshot = [...list]
        const remaining = list.filter((item) => !item.once)
        if (remaining.length === 0) this.#listeners.delete(event)
        else this.#listeners.set(event, remaining)
        for (const item of snapshot) item.fn(...args)
        return true
    }

    listeners(event: string | symbol): Listener[] {
        return (this.#listeners.get(event) ?? []).map((item) => item.fn)
    }

    listenerCount(event: string | symbol): number {
        return this.#listeners.get(event)?.length ?? 0
    }

    eventNames(): (string | symbol)[] {
        return [...this.#listeners.keys()]
    }
}

export default EventEmitter
