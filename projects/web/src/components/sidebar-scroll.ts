const viewport = () => document.querySelector<HTMLElement>("#nd-sidebar [data-radix-scroll-area-viewport]")

// Each client navigation renders a new sidebar scrolled to the top, and Fumadocs then scrolls the active link
// to the nearest edge, so the link just clicked moves. Carrying the offset over keeps the sidebar still, and
// Fumadocs still reveals an active link that the offset leaves hidden
export function setupSidebarScroll() {
    let offset: number | undefined
    document.addEventListener("astro:before-swap", () => {
        offset = viewport()?.scrollTop
    })
    document.addEventListener("astro:after-swap", () => {
        const element = viewport()
        if (element && offset !== undefined) element.scrollTop = offset
        offset = undefined
    })
}
