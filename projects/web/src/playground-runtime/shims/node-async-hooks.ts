// Browser shim for node:async_hooks (AsyncLocalStorage)

export class AsyncLocalStorage<T> {
    #stack: T[] = []

    getStore(): T | undefined {
        return this.#stack.length > 0 ? this.#stack[this.#stack.length - 1] : undefined
    }

    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
        this.#stack.push(store)
        try {
            return callback(...args)
        } finally {
            this.#stack.pop()
        }
    }

    enterWith(store: T): void {
        if (this.#stack.length === 0) this.#stack.push(store)
        else this.#stack[this.#stack.length - 1] = store
    }

    disable(): void {
        this.#stack = []
    }
}

export default { AsyncLocalStorage }
