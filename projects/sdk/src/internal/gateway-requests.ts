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
