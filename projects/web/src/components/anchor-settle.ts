// Reference blocks skip offscreen layout, so after a client navigation the blocks around an anchor reach their real
// size only once they render, which moves the anchor. A full page load repeats fragment scrolling while layout
// changes, but the client router scrolls once, so hold the anchor in place until it settles or the reader takes over
export function setupAnchorSettle() {
    let swapped = false
    document.addEventListener("astro:after-swap", () => {
        swapped = true
    })
    document.addEventListener("astro:page-load", () => {
        // The browser already keeps a full page load's fragment in place
        if (!swapped) return
        swapped = false
        const id = decodeURIComponent(location.hash.slice(1))
        const target = id ? document.getElementById(id) : null
        if (!target?.closest("[data-api-reference]")) return
        const expected = target.getBoundingClientRect().top
        const input = new AbortController()
        for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
            addEventListener(type, () => input.abort(), { signal: input.signal, passive: true, capture: true })
        document.addEventListener("astro:before-swap", () => input.abort(), { signal: input.signal })
        let frames = 0
        let stable = 0
        const settle = () => {
            if (input.signal.aborted) return
            const offset = target.getBoundingClientRect().top - expected
            if (Math.abs(offset) < 1) stable++
            else {
                stable = 0
                scrollBy({ top: offset, behavior: "instant" })
            }
            // About a second at most, ending early once three frames pass without movement
            if (stable < 3 && ++frames < 60) requestAnimationFrame(settle)
            else input.abort()
        }
        requestAnimationFrame(settle)
    })
}
