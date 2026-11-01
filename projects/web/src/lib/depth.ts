// Anchors the layers of space that keep their own pace. The page's scroll timeline draws each one away from
// its place by its share of the scroll since its anchor, so the anchor must be the scroll position at which
// the layer's layout box is centered on the screen: there it sits exactly where it was placed. Measured
// from layout offsets, which the animation's transform never changes, and written once per layout change,
// so no scroll ever reads layout for it

export function anchorDepth(space: HTMLElement) {
    const box = space.getBoundingClientRect()
    // The page zoom on wide screens: the box as drawn against the box as laid out
    const zoom = space.offsetWidth > 0 ? box.width / space.offsetWidth : 1
    const spaceTop = box.top + window.scrollY
    const viewport = window.innerHeight
    for (const element of space.querySelectorAll<HTMLElement>(".depth, [data-depth]")) {
        let top = 0
        let node: Element | null = element
        while (node instanceof HTMLElement && node !== space) {
            top += node.offsetTop
            node = node.offsetParent
        }
        const anchor = spaceTop + (top + element.offsetHeight / 2) * zoom - viewport / 2
        element.style.setProperty("--anchor", `${anchor.toFixed(1)}px`)
    }
}

// Where a space starts on the page, which its star fields slide against
export function markSpaceTop(space: HTMLElement) {
    space.style.setProperty("--night-top", `${(space.getBoundingClientRect().top + window.scrollY).toFixed(1)}px`)
}

// A section's heading stays pinned while its content scrolls, but only where it fits: on a short screen, or with a tall
// list beside it, a pinned heading would keep its own lower part out of view. Measured with the rest of the layout
export function fitPinnedIntros(space: HTMLElement) {
    const zoom = space.offsetWidth > 0 ? space.getBoundingClientRect().width / space.offsetWidth : 1
    const room = window.innerHeight / zoom
    for (const intro of space.querySelectorAll<HTMLElement>(".split > .intro")) {
        const top = parseFloat(getComputedStyle(intro).top) || 0
        intro.toggleAttribute("data-unpinned", intro.offsetHeight + top + 16 > room)
    }
}
