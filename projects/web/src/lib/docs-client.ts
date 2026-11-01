// The docs' small behaviors: the package manager and code language choices, copy buttons, the menu on narrow
// screens, the switch between guides and reference, the outline's current heading and its smooth scrolling,
// and the sidebar's reach above the footer. How the course carries over from page to page lives in
// CourseState, which has to run before the first frame
import { reportCopyFailed } from "./copy-failed"
import { getExperience, subscribeExperience } from "./experience"
import { packageManagers, type PackageManager } from "./links"

const pmKey = "fluxerly.pm.v1"
const langKey = "fluxerly.lang.v1"
type Language = "js" | "ts"

const root = document.documentElement
const still = () => getExperience() === "still"
const isManager = (value: unknown): value is PackageManager => packageManagers.some((item) => item.id === value)
// The page zoom on wide screens: positions read from the viewport are in the root's pixels, the layout's own
// pixels are smaller by this much
const pageZoom = () => Number(getComputedStyle(root).getPropertyValue("--page-zoom")) || 1

function store(key: string, value: string) {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Storage is blocked, the choice lasts for this page
    }
}

// Still, chosen or asked for by the system, on the body: the night's inline script set it before the first
// paint, this keeps it in step with the switch. The stylesheet stops every slide and drift while it is set
const applyStill = () => document.body.toggleAttribute("data-still", still())
applyStill()
subscribeExperience(applyStill)

// The head script already set the stored choices on <html>. These keep the switches and file names in step
function applyManager(pm: PackageManager) {
    if (pm === "npm") delete root.dataset.pm
    else root.dataset.pm = pm
    for (const button of document.querySelectorAll<HTMLElement>("[data-set-pm]")) button.setAttribute("aria-pressed", String(button.dataset.setPm === pm))
}

function applyLanguage(lang: Language) {
    if (lang === "js") delete root.dataset.lang
    else root.dataset.lang = lang
    for (const button of document.querySelectorAll<HTMLElement>("[data-set-lang]")) button.setAttribute("aria-pressed", String(button.dataset.setLang === lang))
    for (const name of document.querySelectorAll<HTMLElement>("[data-example-filename]")) name.textContent = (name.textContent ?? "").replace(/\.(js|ts)$/, `.${lang}`)
}

applyManager(isManager(root.dataset.pm) ? root.dataset.pm : "npm")
applyLanguage(root.dataset.lang === "ts" ? "ts" : "js")

// A page rendered ahead of time catches up with choices made on the page before it while it waited
window.addEventListener("pagereveal", () => {
    try {
        const pm = localStorage.getItem(pmKey)
        applyManager(isManager(pm) ? pm : "npm")
        applyLanguage(localStorage.getItem(langKey) === "ts" ? "ts" : "js")
    } catch {
        // Storage is blocked, the page keeps what it opened with
    }
})

// The homepage's install chips announce their choice with the same event
window.addEventListener("fluxerly:pm", (event) => {
    const next = (event as CustomEvent).detail
    if (isManager(next)) applyManager(next)
})

// Switching changes the height of every block above, so the clicked switch stays where the reader saw it
function keepInPlace(anchor: Element, change: () => void) {
    const before = anchor.getBoundingClientRect().top
    change()
    window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: "instant" })
}

// A long code block's other half, in both its languages, so switching language keeps the block as it was
function setCodeOpen(frame: Element, open: boolean) {
    for (const rest of frame.querySelectorAll<HTMLElement>(".code-rest")) {
        if (open) rest.removeAttribute("hidden")
        else rest.setAttribute("hidden", "until-found")
    }
    for (const button of frame.querySelectorAll<HTMLElement>("[data-code-more]")) {
        button.setAttribute("aria-expanded", String(open))
        button.textContent = (open ? button.dataset.hide : button.dataset.show) ?? ""
    }
}

// While the site moves, the rest of a long block unrolls instead of appearing at once. Closing pulls the button up, so the page
// follows to keep it where the reader's finger is. Opening leaves the reader at the line they were on
let codeSliding = false
function slideCode(frame: Element, button: HTMLElement, open: boolean) {
    if (codeSliding) return
    const rest = [...frame.querySelectorAll<HTMLElement>(".code-rest")].find((element) => element.closest("pre")?.checkVisibility())
    if (still() || !rest) {
        if (open) setCodeOpen(frame, true)
        else keepInPlace(button, () => setCodeOpen(frame, false))
        return
    }
    if (open) setCodeOpen(frame, true)
    const height = rest.offsetHeight
    const motion = rest.animate(
        { height: open ? ["0px", `${height}px`] : [`${height}px`, "0px"], overflow: ["clip", "clip"] },
        { duration: Math.min(900, 320 + height / 4), easing: "cubic-bezier(0.35, 0, 0.65, 1)", fill: "both" },
    )
    codeSliding = true
    if (!open) {
        button.setAttribute("aria-expanded", "false")
        let top = button.getBoundingClientRect().top
        const follow = () => {
            if (motion.playState !== "running") return
            const now = button.getBoundingClientRect().top
            if (now !== top) window.scrollBy({ top: now - top, behavior: "instant" })
            top = button.getBoundingClientRect().top
            requestAnimationFrame(follow)
        }
        requestAnimationFrame(follow)
    }
    motion.finished
        .catch(() => {})
        .then(() => {
            codeSliding = false
            if (open) motion.cancel()
            else
                keepInPlace(button, () => {
                    setCodeOpen(frame, false)
                    motion.cancel()
                })
        })
}

// The browser's own find opened a long block's other half to show a match
document.addEventListener("beforematch", (event) => {
    const rest = event.target as Element
    if (!rest.matches(".code-rest")) return
    const frame = rest.closest(".code-frame") ?? rest.closest("pre")?.parentElement
    if (frame) setCodeOpen(frame, true)
})

// The version menu closes on a press elsewhere or Escape, like any menu
const versionMenu = document.querySelector<HTMLDetailsElement>("[data-version-menu]")
if (versionMenu) {
    document.addEventListener("click", (event) => {
        if (versionMenu.open && !versionMenu.contains(event.target as Node)) versionMenu.open = false
    })
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !versionMenu.open) return
        versionMenu.open = false
        versionMenu.querySelector("summary")?.focus()
    })
}

// Changing version keeps the page when that version has it, and otherwise opens that version's overview
document.addEventListener("click", async (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("[data-docs-version]")
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    const here = import.meta.env.PUBLIC_DOCS_BASE ?? "/docs/"
    const base = link.dataset.docsVersion ?? "/docs/"
    const page = location.pathname.startsWith(here) ? location.pathname.slice(here.length) : ""
    const target = base + page
    const found = page ? await fetch(target, { method: "HEAD" }).then((response) => response.ok, () => false) : true
    location.assign(found ? target + location.hash : base)
})

const copyResets = new WeakMap<HTMLElement, number>()

function showCopied(copy: HTMLElement) {
    const status = copy.nextElementSibling as HTMLElement | null
    copy.dataset.copied = "true"
    if (status) status.textContent = "Copied"
    window.clearTimeout(copyResets.get(copy))
    copyResets.set(
        copy,
        window.setTimeout(() => {
            delete copy.dataset.copied
            if (status) status.textContent = ""
        }, 1800),
    )
}

document.addEventListener("click", async (event) => {
    const target = event.target as Element
    const pmButton = target.closest<HTMLElement>("[data-set-pm]")
    if (pmButton && isManager(pmButton.dataset.setPm)) {
        const pm = pmButton.dataset.setPm
        keepInPlace(pmButton, () => applyManager(pm))
        store(pmKey, pm)
        window.dispatchEvent(new CustomEvent("fluxerly:pm", { detail: pm }))
        return
    }
    const langButton = target.closest<HTMLElement>("[data-set-lang]")
    if (langButton) {
        const lang: Language = langButton.dataset.setLang === "ts" ? "ts" : "js"
        keepInPlace(langButton, () => applyLanguage(lang))
        store(langKey, lang)
        return
    }
    const more = target.closest<HTMLElement>("[data-code-more]")
    if (more) {
        const frame = more.closest(".code-frame") ?? more.parentElement
        if (!frame) return
        const open = more.getAttribute("aria-expanded") !== "true"
        slideCode(frame, more, open)
        return
    }
    const copyMarkdown = target.closest<HTMLElement>("[data-copy-markdown]")
    if (copyMarkdown) {
        try {
            // The clipboard is opened in the press itself and handed the download, which is the one way Safari allows it
            const text = fetch(copyMarkdown.dataset.copyMarkdown!).then(async (response) => {
                if (!response.ok) throw new Error(`The page's Markdown answered HTTP ${response.status}`)
                return new Blob([await response.text()], { type: "text/plain" })
            })
            await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })])
        } catch (error) {
            reportCopyFailed(error)
            return
        }
        showCopied(copyMarkdown)
        return
    }
    const copy = target.closest<HTMLElement>("[data-copy]")
    if (copy) {
        const owner = copy.closest("[data-copy-root]")
        const source = [...(owner?.querySelectorAll<HTMLElement>("[data-copy-text]") ?? [])].find((element) => element.checkVisibility())
        try {
            await navigator.clipboard.writeText(((source?.querySelector("pre") ?? source)?.textContent ?? "").trimEnd())
        } catch (error) {
            reportCopyFailed(error)
            return
        }
        showCopied(copy)
    }
})

// The sidebar is a sheet on narrow screens, opened from the Docs menu button
const side = document.querySelector<HTMLElement>("[data-side]")
const opener = document.querySelector<HTMLButtonElement>("[data-side-open]")
const courseScroll = document.querySelector<HTMLElement>("[data-course-scroll]")
const shownPart = () => document.querySelector<HTMLElement>("[data-part]:not([hidden])")

function setSide(open: boolean) {
    if (!side || !opener) return
    side.toggleAttribute("data-open", open)
    root.toggleAttribute("data-side-open", open)
    opener.setAttribute("aria-expanded", String(open))
    if (open) (shownPart()?.querySelector<HTMLElement>("a[aria-current='page']") ?? side.querySelector<HTMLElement>("input, button"))?.focus({ preventScroll: true })
    else opener.focus()
}
opener?.addEventListener("click", () => setSide(true))
for (const closer of document.querySelectorAll("[data-side-close]")) closer.addEventListener("click", () => setSide(false))
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && side?.hasAttribute("data-open") && !document.querySelector("dialog[open]")) setSide(false)
})

// Guides or reference: a tab switch over the two courses. Arrow keys move between the tabs. The course that opens shows
// the current page when it holds it, otherwise its start
const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-part-tab]")]
function choosePart(tab: HTMLButtonElement) {
    const part = document.getElementById(tab.getAttribute("aria-controls") ?? "")
    if (!part || !part.hidden) return
    for (const other of tabs) {
        const selected = other === tab
        other.setAttribute("aria-selected", String(selected))
        other.tabIndex = selected ? 0 : -1
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-part]")) panel.hidden = panel !== part
    if (!still()) {
        part.dataset.switched = ""
        part.addEventListener("animationend", () => delete part.dataset.switched, { once: true })
    }
    if (!courseScroll) return
    const here = part.querySelector<HTMLElement>("a[aria-current='page']")
    courseScroll.scrollTop = 0
    if (here?.checkVisibility()) courseScroll.scrollTop = here.offsetTop + part.offsetTop - (courseScroll.clientHeight - here.offsetHeight) / 2
}
for (const tab of tabs) {
    tab.addEventListener("click", () => choosePart(tab))
    tab.addEventListener("keydown", (event) => {
        const at = tabs.indexOf(tab)
        const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[event.key]
        if (to === undefined) return
        event.preventDefault()
        const next = tabs[(to + tabs.length) % tabs.length]
        if (!next) return
        next.focus()
        choosePart(next)
    })
}

// Guides already opened keep a quiet bead on the rail, remembered only in this browser
const visitedKey = "fluxerly.visited.v1"
function markVisited() {
    let visited: string[] = []
    try {
        visited = JSON.parse(window.localStorage.getItem(visitedKey) ?? "[]") as string[]
        if (!visited.includes(location.pathname)) {
            visited = [...visited, location.pathname].slice(-300)
            window.localStorage.setItem(visitedKey, JSON.stringify(visited))
        }
    } catch {
        // Storage is blocked, the rail simply stays plain
    }
    for (const link of document.querySelectorAll<HTMLAnchorElement>(".course-list a")) link.toggleAttribute("data-visited", visited.includes(link.pathname))
}
markVisited()
window.addEventListener("pageshow", markVisited)

// A followed course link keeps its mark on the rail until the next page arrives, which a slow network makes visible
document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-course-link]")
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (link.getAttribute("aria-current") !== "page") link.dataset.pending = ""
})
window.addEventListener("pageshow", () => {
    for (const link of document.querySelectorAll<HTMLElement>("[data-pending]")) delete link.dataset.pending
})

// An outline entry scrolls the page to its heading: smoothly while the world moves, at once in Still. The move is
// the link's own fragment navigation, so the address, the history, the linked row's mark and the keyboard's place
// all follow as they would from any link. The page's scroll behaviour decides how such a navigation scrolls, so it
// is set for the one move and cleared when the move has ended
let settleScroll = 0
document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("[data-outline-link], [data-fold-link]")
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)))
    if (!heading) return
    event.preventDefault()
    const smooth = !still()
    root.style.scrollBehavior = smooth ? "smooth" : "auto"
    // The same address again is not a navigation, so the heading is scrolled to directly
    if (location.hash === link.hash) heading.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "start" })
    else location.hash = link.hash
    const settle = () => {
        window.clearTimeout(settleScroll)
        root.style.scrollBehavior = ""
    }
    window.clearTimeout(settleScroll)
    if (!smooth) settle()
    else {
        window.addEventListener("scrollend", settle, { once: true })
        settleScroll = window.setTimeout(settle, 1500)
    }
})

// The outline marks the last heading that has passed under the header. At the bottom of the page the last heading is
// current, even when it cannot reach the header. The outline scrolls on its own and keeps its current entry in view,
// unless the pointer is over it, when the reader is scrolling it themselves. The mark is checked again as a page is
// revealed, so a page opened at a heading or arriving from a prerender is right in its first frame
const outline = document.querySelector<HTMLElement>("[data-outline-root]")
const outlineEntries = [...document.querySelectorAll<HTMLAnchorElement>("[data-outline-link]")]
    .map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter((entry): entry is { link: HTMLAnchorElement; heading: HTMLElement } => entry.heading !== null)
// The footer passes over the floating sidebar and outline. Where it does, they end above it, so a focused link in
// them is never out of sight under it
const footer = document.querySelector<HTMLElement>(".site-footer")
const floating = [side, outline].filter((panel): panel is HTMLElement => panel !== null)
let footerCut = 0
function cutAboveFooter() {
    if (!footer) return
    const cut = Math.max(0, Math.round((window.innerHeight - footer.getBoundingClientRect().top) / pageZoom()))
    if (cut === footerCut) return
    footerCut = cut
    for (const panel of floating) panel.style.setProperty("--footer-cut", `${cut}px`)
}
{
    let frame = 0
    let shown: HTMLAnchorElement | undefined
    let visible = outlineEntries
    let held = false
    const schedule = () => (frame ||= requestAnimationFrame(update))
    // A section hidden by a filter, such as an area of the endpoint map, takes its outline entry with it. A hidden
    // heading measures 0 from the top, so it would otherwise count as passed and take the current mark
    const refresh = () => {
        visible = outlineEntries.filter(({ link, heading }) => {
            const hidden = heading.closest("[hidden]") !== null
            const item = link.closest("li") ?? link
            if (item.hidden !== hidden) item.hidden = hidden
            return !hidden
        })
    }
    const mark = () => {
        if (!visible.length) return
        let current = visible[0]!
        for (const entry of visible) if (entry.heading.getBoundingClientRect().top < 140) current = entry
        const page = document.scrollingElement ?? root
        if (page.scrollTop > 0 && page.scrollTop + page.clientHeight >= page.scrollHeight - 2) current = visible.at(-1)!
        if (current.link === shown) return
        const link = (shown = current.link)
        for (const entry of outlineEntries) entry.link === link ? entry.link.setAttribute("aria-current", "location") : entry.link.removeAttribute("aria-current")
        // In the outline's own pixels, clear of its top and bottom padding
        if (!outline || held || outline.scrollHeight <= outline.clientHeight) return
        let top = 0
        for (let node: HTMLElement | null = link; node && node !== outline; node = node.offsetParent as HTMLElement | null) top += node.offsetTop
        top -= outline.scrollTop
        const bottom = top + link.offsetHeight
        const shift = top < 56 ? top - 56 : bottom > outline.clientHeight - 48 ? bottom - outline.clientHeight + 48 : 0
        if (shift) outline.scrollTo({ top: outline.scrollTop + shift, behavior: still() ? "instant" : "smooth" })
    }
    const update = () => {
        frame = 0
        cutAboveFooter()
        mark()
    }
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule, { passive: true })
    window.addEventListener("pagereveal", () => {
        refresh()
        update()
    })
    if (outline) {
        outline.addEventListener("pointerenter", () => (held = true))
        outline.addEventListener("pointerleave", () => (held = false))
    }
    if (outlineEntries.length) {
        new MutationObserver(() => {
            refresh()
            schedule()
        }).observe(document.querySelector("main") ?? document.body, { subtree: true, attributeFilter: ["hidden"] })
        refresh()
    }
    update()
}
