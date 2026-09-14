type Preview = {
    name: string
    kind: string
    description: string
    signature: string
    members: { name: string; detail: string }[]
    more: number
}

const previews = new Map<string, Promise<Preview>>()
const compact = (text: string | null | undefined, limit = 350) => {
    const value = (text ?? "").replace(/\s+/g, " ").trim()
    return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value
}

// Read only the public reference already shipped for the selected docs version
async function readPreview(url: URL): Promise<Preview> {
    const response = await fetch(url.pathname, { credentials: "omit" })
    if (!response.ok) throw new Error("Public reference preview is unavailable")
    const page = new DOMParser().parseFromString(await response.text(), "text/html")
    const content = page.querySelector(".docs-content")
    const name = compact(page.querySelector("h1")?.textContent)
    if (!content || !name) throw new Error("Public reference preview was not found")
    const description = Array.from(content.children).find((node) => node.tagName === "P")
    const members: Preview["members"] = []
    for (const section of content.querySelectorAll("h2")) {
        if (!/^(Properties|Methods|Enumeration Members)$/.test(compact(section.textContent))) continue
        let node = section.nextElementSibling
        while (node && node.tagName !== "H2") {
            if (node.tagName === "TABLE") {
                const typeColumn = Array.from(node.querySelectorAll("thead th")).findIndex((cell) => compact(cell.textContent) === "Type")
                for (const row of node.querySelectorAll("tbody tr")) {
                    const cells = row.querySelectorAll("td")
                    if (cells.length) members.push({ name: compact(cells[0]?.textContent, 90), detail: compact(cells[typeColumn >= 0 ? typeColumn : 1]?.textContent, 140) })
                }
            } else if (node.tagName === "H3") {
                const signature = node.nextElementSibling?.tagName === "BLOCKQUOTE" ? compact(node.nextElementSibling.textContent, 500) : ""
                const separator = signature.indexOf(":")
                members.push({ name: compact(node.textContent, 90), detail: compact(separator >= 0 ? signature.slice(separator + 1) : signature, 140) })
            }
            node = node.nextElementSibling
        }
    }
    const unique = members.filter((member, index) => members.findIndex((other) => other.name === member.name) === index)
    const first = content.firstElementChild
    return {
        name,
        kind: ({ interfaces: "Interface", classes: "Class", types: "Type alias", enums: "Enum" } as Record<string, string>)[url.pathname.split("/")[4]!] ?? "Type",
        description: compact(description?.textContent),
        signature: first?.tagName === "BLOCKQUOTE" ? compact(first.textContent, 220) : "",
        members: unique.slice(0, 10),
        more: Math.max(0, unique.length - 10),
    }
}

function previewFor(url: URL) {
    let preview = previews.get(url.pathname)
    if (!preview) {
        preview = readPreview(url)
        previews.set(url.pathname, preview)
        if (previews.size > 64) previews.delete(previews.keys().next().value!)
        void preview.catch(() => previews.delete(url.pathname))
    }
    return preview
}

let initialized = false
let cleanup = () => {}

export function setupReferencePreviews() {
    if (initialized) return
    initialized = true
    const setup = () => {
        cleanup()
        const content = document.querySelector<HTMLElement>(".docs-content[data-api-reference]")
        if (!content) return
        const events = new AbortController()
        const buttons: HTMLButtonElement[] = []
        const triggers = new Map<HTMLAnchorElement, HTMLButtonElement>()
        const panel = document.createElement("div")
        panel.className = "reference-preview"
        panel.id = "reference-preview"
        panel.setAttribute("role", "dialog")
        panel.setAttribute("aria-label", "Type preview")
        panel.hidden = true
        document.body.append(panel)
        let current: HTMLAnchorElement | null = null
        let timer: ReturnType<typeof setTimeout> | undefined
        let generation = 0
        let dismissed: HTMLAnchorElement | null = null
        const clearTimer = () => { clearTimeout(timer); timer = undefined }
        const close = () => {
            clearTimer()
            generation++
            panel.hidden = true
            current?.removeAttribute("aria-details")
            current?.removeAttribute("aria-describedby")
            if (current) triggers.get(current)?.setAttribute("aria-expanded", "false")
            current = null
        }
        const later = () => {
            clearTimer()
            timer = setTimeout(() => {
                if (!panel.matches(":hover") && !panel.contains(document.activeElement) && document.activeElement !== current) close()
            }, 180)
        }
        const position = () => {
            if (!current || panel.hidden) return
            const anchor = current.getBoundingClientRect()
            const width = panel.offsetWidth
            const height = panel.offsetHeight
            const left = Math.max(12, Math.min(anchor.left, innerWidth - width - 12))
            const below = anchor.bottom + 10
            const top = below + height <= innerHeight - 12 ? below : Math.max(12, anchor.top - height - 10)
            panel.style.left = `${left}px`
            panel.style.top = `${top}px`
        }
        const add = (tag: string, text: string, className?: string) => {
            const node = document.createElement(tag)
            node.textContent = text
            if (className) node.className = className
            panel.append(node)
            return node
        }
        const open = async (link: HTMLAnchorElement, force = false) => {
            clearTimer()
            if (dismissed === link && !force) return
            if (current === link && !panel.hidden) return
            close()
            current = link
            const request = ++generation
            const url = new URL(link.href)
            try {
                const preview = await previewFor(url).catch(() => ({
                    name: compact(link.textContent),
                    kind: "Type",
                    description: "Preview unavailable. Open the type to read its reference",
                    signature: "",
                    members: [],
                    more: 0,
                }))
                if (generation !== request || !link.isConnected) return
                panel.replaceChildren()
                const closeButton = add("button", "×", "reference-preview-close") as HTMLButtonElement
                closeButton.type = "button"
                closeButton.setAttribute("aria-label", "Close type preview")
                closeButton.addEventListener("click", () => { dismissed = link; close(); link.focus() })
                add("p", preview.kind, "reference-preview-kind")
                add("p", preview.name, "reference-preview-name")
                if (preview.description) add("p", preview.description, "reference-preview-description")
                if (preview.signature) add("code", preview.signature, "reference-preview-signature")
                if (preview.members.length) {
                    const list = add("ul", "", "reference-preview-members")
                    list.tabIndex = 0
                    list.setAttribute("aria-label", "Public members")
                    for (const member of preview.members) {
                        const row = document.createElement("li")
                        const name = document.createElement("code")
                        name.textContent = member.name
                        const detail = document.createElement("span")
                        detail.textContent = member.detail
                        row.append(name, detail)
                        list.append(row)
                    }
                    if (preview.more) {
                        const more = document.createElement("li")
                        more.textContent = `+${preview.more} more`
                        list.append(more)
                    }
                }
                const destination = add("a", "Open type", "reference-preview-open") as HTMLAnchorElement
                destination.href = link.href
                panel.setAttribute("aria-label", `${preview.name} type preview`)
                link.setAttribute("aria-details", panel.id)
                link.setAttribute("aria-describedby", panel.id)
                triggers.get(link)?.setAttribute("aria-expanded", "true")
                panel.hidden = false
                position()
                if (force) closeButton.focus()
            } catch {
                if (generation === request) close()
            }
        }
        for (const link of content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            const url = new URL(link.href)
            const version = location.pathname.split("/")[2]
            if (url.origin !== location.origin || !url.pathname.startsWith(`/docs/${version}/api/`) || !/^\/docs\/[^/]+\/api\/(interfaces|classes|types|enums)\/[^/]+\/?$/.test(url.pathname)) continue
            link.addEventListener("pointerenter", (event) => { dismissed = null; if (event.pointerType !== "touch") void open(link) }, { signal: events.signal })
            link.addEventListener("pointerleave", later, { signal: events.signal })
            link.addEventListener("focus", () => void open(link), { signal: events.signal })
            link.addEventListener("blur", () => { if (dismissed === link) dismissed = null; later() }, { signal: events.signal })
            const button = document.createElement("button")
            button.type = "button"
            button.className = "reference-preview-trigger"
            button.textContent = "ⓘ"
            button.setAttribute("aria-label", `Preview ${compact(link.textContent)}`)
            button.setAttribute("aria-haspopup", "dialog")
            button.setAttribute("aria-controls", panel.id)
            button.setAttribute("aria-expanded", "false")
            button.addEventListener("click", () => { dismissed = null; void open(link, true) }, { signal: events.signal })
            link.after(button)
            buttons.push(button)
            triggers.set(link, button)
        }
        panel.addEventListener("pointerenter", clearTimer, { signal: events.signal })
        panel.addEventListener("pointerleave", later, { signal: events.signal })
        panel.addEventListener("focusout", later, { signal: events.signal })
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || panel.hidden) return
            dismissed = current
            const returnFocus = panel.contains(document.activeElement)
            const link = current
            close()
            if (returnFocus) link?.focus()
        }, { signal: events.signal })
        document.addEventListener("pointerdown", (event) => {
            if (!panel.contains(event.target as Node) && event.target !== current && !(event.target as Element).closest(".reference-preview-trigger")) {
                const returnFocus = panel.contains(document.activeElement)
                const link = current
                dismissed = current
                close()
                if (returnFocus) link?.focus()
            }
        }, { signal: events.signal })
        window.addEventListener("scroll", position, { signal: events.signal, passive: true, capture: true })
        window.addEventListener("resize", position, { signal: events.signal, passive: true })
        cleanup = () => { events.abort(); close(); panel.remove(); buttons.forEach((button) => button.remove()) }
    }
    document.addEventListener("astro:page-load", setup)
    document.addEventListener("astro:before-swap", () => cleanup())
    setup()
}
