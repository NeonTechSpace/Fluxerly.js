/** Shared local admission for count and member requests, not a claim about Fluxer's other bounded-command workers */
export class GatewayRequestBudget {
    #active = 0

    acquire(): (() => void) | undefined {
        if (this.#active === 4) return undefined
        this.#active++
        let active = true
        return () => {
            if (!active) return
            active = false
            this.#active--
        }
    }
}
