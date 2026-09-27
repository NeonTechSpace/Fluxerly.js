/**
 * Gateway request admission shared by count and member-chunk requests.
 * Invariant: The limit applies to the whole client, not each local shard, and no roster, count or distributed coordinator is kept.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
const activeRequestCapacity = 4

/** Shared local admission for count and member requests, not a claim about Fluxer's other bounded-command workers */
export class GatewayRequestBudget {
    #active = 0

    diagnostics() {
        return { activeRequests: this.#active, activeCapacity: activeRequestCapacity }
    }

    acquire(): (() => void) | undefined {
        if (this.#active === activeRequestCapacity) return undefined
        this.#active++
        let active = true
        return () => {
            if (!active) return
            active = false
            this.#active--
        }
    }
}
