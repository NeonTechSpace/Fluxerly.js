// The docs' hover peeks. A mark from src/lib/rehype-peek.ts, or a link in the prose to the reference, the codes or the
// glossary, shows a small card with what the thing is and means. It opens after a short pause under a mouse or pen
// and at once on keyboard focus, and it stays open while the pointer moves into it, so its link can be followed.
// Escape, leaving or losing focus closes it. A touch only follows the link. The card's data is one JSON file built
// with the site, fetched on the first hover, so a page carries nothing extra until then
import { getExperience, prefersReducedMotion } from "./experience"
import type { PeekEntry } from "./peek-index"

// A published version's pages are built under their own address, and read that version's meanings
const indexUrl = `${import.meta.env.PUBLIC_DOCS_BASE ?? "/docs/"}peek.json`
const openDelay = 300
// Long enough to cross the gap between a mark and its card
const closeDelay = 160
const gap = 8
const margin = 12

let entries: Promise<Record<string, PeekEntry> | undefined> | undefined

function load() {
    entries ??= fetch(indexUrl)
        .then((response) => (response.ok ? (response.json() as Promise<{ entries: Record<string, PeekEntry> }>) : undefined))
        .then((index) => index?.entries)
        .catch(() => undefined)
        .then((loaded) => {
            // A failed load is tried again on the next hover
            if (!loaded) entries = undefined
            return loaded
        })
    return entries
}

const still = () => getExperience() === "still" || prefersReducedMotion()

function keyOf(link: HTMLAnchorElement): string | undefined {
    if (link.dataset.peek) return link.dataset.peek
    const url = new URL(link.href, location.href)
    if (url.origin !== location.origin || !/^\/docs\/(?:nightly\/|\d[^/]*\/)?(?:api|codes|glossary)\//.test(url.pathname)) return undefined
    return url.pathname + url.hash
}

// Peeks open in the article only, and not on headings, a row's own # anchor, breadcrumbs or example code
function triggerOf(target: EventTarget | null): HTMLAnchorElement | undefined {
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null
    if (!link?.closest(".docs-article") || link.closest("h1, h2, h3, h4, h5, h6, .ref-mark, .entry-mark, .crumbs, .code-frame, .peek-card")) return undefined
    return keyOf(link) ? link : undefined
}

const linkLabel = (href: string) => {
    const page = href.replace(/^\/docs\/(?:nightly\/|\d[^/]*\/)/, "/docs/")
    return page.startsWith("/docs/codes/") ? "Open in codes" : page.startsWith("/docs/glossary/") ? "In the glossary" : "Open in reference"
}

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

// Phosphor's ArrowRight
const arrow =
    '<svg class="peek-arrow" viewBox="0 0 256 256" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"/></svg>'

// The index is built with the site from the SDK's own documentation, so its HTML goes in as it is
function cardHtml(key: string, own: PeekEntry, all: Record<string, PeekEntry>): string {
    const entry = { ...(own.p ? all[own.p] : undefined), ...own }
    const href = entry.u ?? key
    const flag = (level: string, extra = "") => `<span class="peek-flag${extra}" data-level="${escape(level.toLowerCase())}">${escape(level)}</span>`
    const title =
        entry.f === "level"
            ? flag(entry.t, " peek-flag-title")
            : entry.f === "code"
              ? `<code class="peek-chip">${entry.t}</code>${entry.lv?.map((level) => flag(level)).join("") ?? ""}`
              : entry.f === "term"
                ? `<span class="peek-term-title">${entry.t}</span>`
                : `<code class="peek-sig">${entry.t}</code>`
    return [
        `<div class="peek-title">${title}</div>`,
        entry.d ? `<p class="peek-text">${entry.d}</p>` : "",
        // A level's second line lists what appears at it, as the logging guide's table does
        entry.x ? `<p class="peek-extra">${entry.f === "level" ? '<span class="peek-label">What appears</span>' : ""}${entry.x}</p>` : "",
        entry.a ? `<p class="peek-action"><span class="peek-label">Next step</span>${entry.a}</p>` : "",
        `<div class="peek-foot"><span class="peek-kind">${escape(entry.k)}</span>`,
        // The mark itself links to the same place, so the card's link stays out of the tab order
        `<a class="peek-link" href="${escape(href)}" tabindex="-1">${escape(entry.l ?? linkLabel(href))}${arrow}</a></div>`,
    ].join("")
}

let card: HTMLDivElement | undefined
/** The mark whose card is wanted, open or on its way */
let wanted: HTMLAnchorElement | undefined
/** The mark whose card is showing */
let shown: HTMLAnchorElement | undefined
let openTimer: number | undefined
let closeTimer: number | undefined
let pointerY: number | undefined
let previousDescription: string | null = null

function cardElement(): HTMLDivElement {
    if (card) return card
    card = document.createElement("div")
    card.className = "peek-card"
    card.id = "docs-peek"
    card.setAttribute("role", "tooltip")
    card.hidden = true
    card.addEventListener("pointerenter", () => clearTimeout(closeTimer))
    card.addEventListener("pointerleave", (event) => {
        if (!shown?.contains(event.relatedTarget as Node | null)) scheduleClose()
    })
    document.body.append(card)
    return card
}

// The page's own zoom on wide screens scales the card too, so places are measured on screen and set in its units
const zoom = () => Number.parseFloat(getComputedStyle(document.body).zoom) || 1

function place(trigger: HTMLAnchorElement, peek: HTMLDivElement) {
    const scale = zoom()
    const box = trigger.getBoundingClientRect()
    const lines = [...trigger.getClientRects()]
    // A mark that wraps lines up with the line under the pointer
    const line = (pointerY !== undefined && lines.find((rect) => pointerY! >= rect.top && pointerY! <= rect.bottom)) || lines[0] || box
    const width = peek.offsetWidth * scale
    const height = peek.offsetHeight * scale
    const viewWidth = document.documentElement.clientWidth
    const viewHeight = window.innerHeight
    const left = Math.max(margin, Math.min(line.left, viewWidth - margin - width))
    // Below the whole mark when it fits, else above it, so the card never covers the words it explains
    const below = box.bottom + gap
    const above = box.top - gap - height
    const top = below + height <= viewHeight - margin || above < margin ? below : above
    peek.style.left = `${left / scale}px`
    peek.style.top = `${top / scale}px`
    peek.dataset.side = top === below ? "below" : "above"
}

async function open(trigger: HTMLAnchorElement) {
    const key = keyOf(trigger)
    const all = key ? await load() : undefined
    const entry = key ? all?.[key] : undefined
    // The pointer may have moved on while the index loaded
    if (!key || !entry || !all || wanted !== trigger || !trigger.isConnected) return
    const peek = cardElement()
    peek.innerHTML = cardHtml(key, entry, all)
    peek.dataset.form = entry.f ?? "sig"
    if (entry.f === "level") peek.dataset.level = entry.t.toLowerCase()
    else delete peek.dataset.level
    peek.toggleAttribute("data-still", still())
    shown = trigger
    previousDescription = trigger.getAttribute("aria-describedby")
    trigger.setAttribute("aria-describedby", [previousDescription, peek.id].filter(Boolean).join(" "))
    peek.classList.remove("is-open")
    peek.hidden = false
    place(trigger, peek)
    // The next frame starts the fade in, which Still and reduced motion leave out
    requestAnimationFrame(() => peek.classList.add("is-open"))
}

function close() {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    if (shown) {
        if (previousDescription) shown.setAttribute("aria-describedby", previousDescription)
        else shown.removeAttribute("aria-describedby")
    }
    previousDescription = null
    wanted = shown = undefined
    if (card) {
        card.hidden = true
        card.classList.remove("is-open")
    }
}

function scheduleClose() {
    clearTimeout(closeTimer)
    closeTimer = window.setTimeout(close, closeDelay)
}

function intend(trigger: HTMLAnchorElement, delay: number) {
    clearTimeout(closeTimer)
    if (trigger === wanted) return
    close()
    wanted = trigger
    void load()
    openTimer = window.setTimeout(() => void open(trigger), delay)
}

function setup() {
    document.addEventListener("pointerover", (event) => {
        // A touch follows the link, with no peek in the way
        if (event.pointerType === "touch") return
        const trigger = triggerOf(event.target)
        if (!trigger) return
        pointerY = event.clientY
        intend(trigger, openDelay)
    })
    document.addEventListener("pointerout", (event) => {
        if (event.pointerType === "touch") return
        const trigger = triggerOf(event.target)
        const to = event.relatedTarget as Node | null
        if (!trigger || trigger !== wanted || trigger.contains(to) || card?.contains(to)) return
        // Leaving before the card opened cancels it. Leaving an open card's mark gives the pointer time to reach it
        if (shown) scheduleClose()
        else close()
    })
    document.addEventListener("focusin", (event) => {
        const trigger = triggerOf(event.target)
        // Keyboard focus only. A click or a tap also focuses the link, and should not open a card
        if (!trigger?.matches(":focus-visible")) return
        pointerY = undefined
        intend(trigger, 0)
    })
    document.addEventListener("focusout", (event) => {
        if (wanted && event.target === wanted && !card?.contains(event.relatedTarget as Node | null)) close()
    })
    // Before other Escape handlers, such as the docs menu's, so the first press only closes the card
    window.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape" || !wanted) return
            close()
            event.stopPropagation()
        },
        true,
    )
    // The card follows its mark while the page scrolls, and closes when the layout changes
    let frame = 0
    window.addEventListener(
        "scroll",
        () => {
            if (!shown || frame) return
            frame = requestAnimationFrame(() => {
                frame = 0
                if (shown && card) place(shown, card)
            })
        },
        { passive: true },
    )
    window.addEventListener("resize", close)
}

setup()
