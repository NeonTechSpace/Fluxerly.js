/**
 * Expiry ordering shared by the caches: A lazy-deletion heap and a timer rescheduled only when the earliest deadline changes.
 * Invariant: Expiry never scans every retained entry on write.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { LogicalScheduler, LogicalTimer } from "./logical-scheduler.js"

/** An entry with a fixed expiry deadline in the owning cache's clock units */
export interface Expiring {
    readonly expires: number
}

/** A lazy-deletion min-heap of cache entries ordered by expiry deadline.
 * Replaced or removed entries stay in the heap until they reach the top or a compaction rebuilds it,
 * so writes cost O(log n) instead of scanning every retained entry
 */
export class ExpiryQueue<E extends Expiring> {
    #heap: E[] = []

    constructor(private readonly live: (entry: E) => boolean) {}

    get size() {
        return this.#heap.length
    }

    push(entry: E) {
        const heap = this.#heap
        heap.push(entry)
        let index = heap.length - 1
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (heap[parent]!.expires <= entry.expires) break
            heap[index] = heap[parent]!
            index = parent
        }
        heap[index] = entry
    }

    #pop(): E {
        const heap = this.#heap
        const top = heap[0]!
        const last = heap.pop()!
        if (heap.length) {
            let index = 0
            const length = heap.length
            while (true) {
                const left = index * 2 + 1
                if (left >= length) break
                const right = left + 1
                const child = right < length && heap[right]!.expires < heap[left]!.expires ? right : left
                if (heap[child]!.expires >= last.expires) break
                heap[index] = heap[child]!
                index = child
            }
            heap[index] = last
        }
        return top
    }

    /** Remove every live entry whose deadline has passed, in deadline order, stopping at the first unexpired entry */
    purge(now: number, remove: (entry: E) => void) {
        while (this.#heap.length) {
            const top = this.#heap[0]!
            if (!this.live(top)) this.#pop()
            else if (top.expires <= now) remove(this.#pop())
            else break
        }
    }

    /** Earliest live deadline, or undefined when no live entry expires */
    next(): number | undefined {
        while (this.#heap.length && !this.live(this.#heap[0]!)) this.#pop()
        return this.#heap[0]?.expires
    }

    /** Rebuild from live entries when stale references dominate, bounding retained references to a multiple of live entries */
    compact(liveEntries: number) {
        if (this.#heap.length <= liveEntries * 2 + 64) return
        const live = this.#heap.filter(this.live)
        this.#heap = []
        for (const entry of live) this.push(entry)
    }

    clear() {
        this.#heap = []
    }
}

/** One cache's expiry timer, rescheduled only when its earliest deadline changes */
export class ExpiryTimer {
    #timer: ReturnType<typeof setTimeout> | LogicalTimer | undefined
    #deadline: number | undefined

    constructor(
        private readonly owner: string,
        private readonly now: () => number,
        private readonly callback: () => void,
        private readonly logical?: LogicalScheduler,
    ) {}

    /** Arm the timer for deadline, or cancel it for undefined. An unchanged deadline keeps the existing timer */
    set(deadline: number | undefined) {
        if (deadline === this.#deadline && (deadline === undefined || this.#timer !== undefined)) return
        this.cancel()
        if (deadline === undefined) return
        this.#deadline = deadline
        const run = () => {
            this.#timer = undefined
            this.#deadline = undefined
            this.callback()
        }
        const delay = Math.min(2_147_483_647, Math.max(1, Math.ceil(deadline - this.now())))
        if (this.logical) this.#timer = this.logical.set(run, delay, this.owner)
        else {
            const timer = setTimeout(run, delay)
            timer.unref()
            this.#timer = timer
        }
    }

    cancel() {
        if (this.#timer !== undefined)
            if (this.logical) this.logical.clear(this.#timer as LogicalTimer)
            else clearTimeout(this.#timer as ReturnType<typeof setTimeout>)
        this.#timer = undefined
        this.#deadline = undefined
    }
}
