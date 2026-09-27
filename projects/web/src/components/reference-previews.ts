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
const pageKinds: Record<string, string> = { interfaces: "Interface", classes: "Class", enums: "Enum" }
const groupKinds: Record<string, string> = {
    "Type Aliases": "Type alias", Functions: "Function", Variables: "Variable",
    Methods: "Method", Properties: "Property", Accessors: "Accessor", Constructors: "Constructor", "Enumeration Members": "Enum member",
}
// Keyboard readers move from a focused type link into its preview with this shortcut
const shortcut = "Alt+ArrowDown"

function tableMembers(table: Element, members: Preview["members"]) {
    const typeColumn = Array.from(table.querySelectorAll("thead th")).findIndex((cell) => compact(cell.textContent) === "Type")
    for (const row of table.querySelectorAll("tbody tr")) {
        const cells = row.querySelectorAll("td")
        if (cells.length) members.push({ name: compact(cells[0]?.textContent, 90), detail: compact(cells[typeColumn >= 0 ? typeColumn : 1]?.textContent, 140) })
    }
}

const headingLevel = (node: Element | null | undefined) => /^H[1-6]$/.test(node?.tagName ?? "") ? Number(node!.tagName[1]) : 0

/**
 * Summarize a symbol page, or a grouped symbol section whose heading has the given level.
 * Levels are read as on a symbol page, where member groups are h2, members h3 and member details h4.
 * Grouped symbols are h3 with h4 details, or one level deeper inside category sections
 */
function summarize(name: string, kind: string, nodes: Element[], symbolLevel = 3): Preview {
    const members: Preview["members"] = []
    let group = ""
    let detail = ""
    const memberGroup = /^(Properties|Methods|Enumeration Members)$/
    const shift = symbolLevel - 3
    for (const [index, node] of nodes.entries()) {
        const level = headingLevel(node) && headingLevel(node) - shift
        if (level === 2) { group = compact(node.textContent); detail = "" }
        else if (level === 3) detail = ""
        else if (level === 4) detail = compact(node.textContent)
        if (node.tagName === "TABLE" && (detail ? /^(Type Declaration|Properties)$/.test(detail) : memberGroup.test(group))) tableMembers(node, members)
        else if (level === 3 && memberGroup.test(group)) {
            const next = nodes[index + 1]
            const signature = next?.tagName === "BLOCKQUOTE" ? compact(next.textContent, 500) : ""
            const separator = signature.indexOf(":")
            members.push({ name: compact(node.textContent, 90), detail: compact(separator >= 0 ? signature.slice(separator + 1) : signature, 140) })
        }
    }
    const unique = members.filter((member, index) => members.findIndex((other) => other.name === member.name) === index)
    return {
        name,
        kind,
        description: compact(nodes.find((node) => node.tagName === "P")?.textContent),
        signature: nodes[0]?.tagName === "BLOCKQUOTE" ? compact(nodes[0].textContent, 220) : "",
        members: unique.slice(0, 10),
        more: Math.max(0, unique.length - 10),
    }
}

// Read only the public reference already shipped for the selected docs version
async function readPreview(url: URL): Promise<Preview> {
    const response = await fetch(url.pathname, { credentials: "omit" })
    if (!response.ok) throw new Error("Public reference preview is unavailable")
    const page = new DOMParser().parseFromString(await response.text(), "text/html")
    const content = page.querySelector(".docs-content")
    if (!content) throw new Error("Public reference preview was not found")
    const children = Array.from(content.children)
    if (!url.hash) {
        const name = compact(page.querySelector("h1")?.textContent)
        if (!name) throw new Error("Public reference preview was not found")
        return summarize(name, pageKinds[url.pathname.split("/")[4]!] ?? "Type", children)
    }
    // Grouped symbols are sections of their entry point page. Members are sections or table rows of their symbol page
    const target = content.querySelector(`[id="${CSS.escape(decodeURIComponent(url.hash.slice(1)))}"]`)
    const owner = pageKinds[url.pathname.split("/")[4]!] ? `${compact(page.querySelector("h1")?.textContent)}.` : ""
    const row = target?.closest("tr")
    if (row && content.contains(row)) return rowPreview(row, owner)
    if (!target || !/^H[2-5]$/.test(target.tagName)) throw new Error("Public reference preview was not found")
    const level = headingLevel(target)
    const section: Element[] = []
    for (let node = target.nextElementSibling; node && !(/^H[1-6]$/.test(node.tagName) && Number(node.tagName[1]) <= level); node = node.nextElementSibling)
        if (node.tagName !== "HR") section.push(node)
    return summarize(owner + compact(target.textContent).replace(/\(\)$/, ""), groupKinds[compact(groupOf(target)?.textContent)] ?? "Type", section, level)
}

/** The kind group of a heading or table, such as Type Aliases or Methods, is the nearest shallower heading above it */
function groupOf(node: Element) {
    const level = headingLevel(node) || 6
    let group = node.previousElementSibling
    while (group && !(headingLevel(group) && headingLevel(group) < level)) group = group.previousElementSibling
    return group
}

/** A property or enum member row, read with its table's column names */
function rowPreview(row: HTMLTableRowElement, owner: string): Preview {
    const table = row.closest("table")!
    const columns = Array.from(table.querySelectorAll("thead th")).map((cell) => compact(cell.textContent))
    const cell = (name: string) => compact(row.cells[columns.indexOf(name)]?.textContent, 220)
    const name = compact(row.cells[0]?.textContent, 90).replace(/\?$/, "")
    const type = cell("Type") || cell("Value")
    // Wrapped tables are read from the wrapper that sits among the page's headings
    let block: Element = table
    while (block.parentElement && !block.parentElement.classList.contains("docs-content")) block = block.parentElement
    const group = compact(groupOf(block)?.textContent)
    return {
        name: owner + name,
        kind: groupKinds[group] ?? "Property",
        description: cell("Description"),
        signature: type ? `${name}: ${type}` : "",
        members: [],
        more: 0,
    }
}

function previewFor(url: URL) {
    const key = url.pathname + url.hash
    let preview = previews.get(key)
    if (!preview) {
        preview = readPreview(url)
        previews.set(key, preview)
        if (previews.size > 64) previews.delete(previews.keys().next().value!)
        void preview.catch(() => previews.delete(key))
    }
    return preview
}

// Links preview their destination. Code block tokens carry their reference URL without being links
const trigger = "a[href], [data-reference]"
const targetOf = (element: Element) => new URL(element.getAttribute("data-reference") ?? (element as HTMLAnchorElement).href, location.href)

/** Public reference links and code tokens in the same version that have a readable preview */
function previewLink(target: EventTarget | null, content: HTMLElement) {
    const link = target instanceof Element ? target.closest<HTMLElement>(trigger) : null
    if (!link || !content.contains(link) || link.closest(".reference-preview")) return null
    const url = targetOf(link)
    const version = location.pathname.split("/")[2]
    if (url.origin !== location.origin || !url.pathname.startsWith(`/docs/${version}/api/`)) return null
    // Symbol pages preview the symbol, or with a fragment one of its members
    if (/^\/docs\/[^/]+\/api\/(interfaces|classes|enums)\/[^/]+\/?$/.test(url.pathname)) return link
    if (/^\/docs\/[^/]+\/api\/modules\/[^/]+\/?$/.test(url.pathname) && url.hash.length > 1) return link
    return null
}

let initialized = false
let cleanup = () => {}

export function setupReferencePreviews() {
    if (initialized) return
    initialized = true
    const setup = () => {
        cleanup()
        // Guides link into the reference too, so every docs page offers the same previews
        const content = document.querySelector<HTMLElement>(".docs-content")
        // A page without reference links gets no preview panel or tap toggle
        if (!content?.querySelector("a[href*=\"/api/\"], [data-reference]")) return
        const events = new AbortController()
        const panel = document.createElement("div")
        panel.className = "reference-preview"
        panel.id = "reference-preview"
        panel.setAttribute("role", "dialog")
        panel.setAttribute("aria-label", "Reference preview")
        panel.hidden = true
        document.body.append(panel)
        // Touch devices have no hover, so one toggle lets a tap preview a type instead of opening it
        const toggle = document.createElement("button")
        toggle.type = "button"
        toggle.className = "reference-preview-toggle"
        toggle.textContent = "Preview types on tap"
        toggle.setAttribute("aria-pressed", "false")
        content.before(toggle)
        let current: HTMLElement | null = null
        let timer: ReturnType<typeof setTimeout> | undefined
        let generation = 0
        let dismissed: HTMLElement | null = null
        const clearTimer = () => { clearTimeout(timer); timer = undefined }
        const close = () => {
            clearTimer()
            generation++
            panel.hidden = true
            current?.removeAttribute("aria-describedby")
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
        const open = async (link: HTMLElement, focusPanel = false) => {
            clearTimer()
            if (dismissed === link && !focusPanel) return
            if (current === link && !panel.hidden) {
                if (focusPanel) panel.querySelector<HTMLElement>(".reference-preview-close")?.focus()
                return
            }
            close()
            current = link
            const request = ++generation
            const url = targetOf(link)
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
                closeButton.setAttribute("aria-label", "Close reference preview")
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
                const destination = add("a", "Open reference", "reference-preview-open") as HTMLAnchorElement
                destination.href = url.href
                add("p", "Alt+Down moves into this preview. Escape closes it", "reference-preview-hint")
                panel.setAttribute("aria-label", `${preview.name} reference preview`)
                link.setAttribute("aria-describedby", panel.id)
                panel.hidden = false
                position()
                if (focusPanel) closeButton.focus()
            } catch {
                if (generation === request) close()
            }
        }
        // One set of delegated listeners serves every type link without adding tab stops
        content.addEventListener("pointerover", (event) => {
            const link = previewLink(event.target, content)
            if (!link || event.pointerType === "touch" || link.contains(event.relatedTarget as Node | null)) return
            dismissed = null
            void open(link)
        }, { signal: events.signal })
        content.addEventListener("pointerout", (event) => {
            const link = previewLink(event.target, content)
            if (link && !link.contains(event.relatedTarget as Node | null)) later()
        }, { signal: events.signal })
        // Focus previews serve keyboard readers. Pointer readers use hover or the touch toggle instead
        let pointerFocus = false
        document.addEventListener("pointerdown", () => { pointerFocus = true }, { signal: events.signal, capture: true })
        document.addEventListener("keydown", () => { pointerFocus = false }, { signal: events.signal, capture: true })
        content.addEventListener("focusin", (event) => {
            const link = previewLink(event.target, content)
            if (link && !pointerFocus) void open(link)
        }, { signal: events.signal })
        content.addEventListener("focusout", (event) => {
            const link = previewLink(event.target, content)
            if (!link) return
            if (dismissed === link) dismissed = null
            later()
        }, { signal: events.signal })
        content.addEventListener("keydown", (event) => {
            const link = previewLink(event.target, content)
            if (!link || event.key !== "ArrowDown" || !event.altKey) return
            event.preventDefault()
            dismissed = null
            void open(link, true)
        }, { signal: events.signal })
        content.addEventListener("click", (event) => {
            if (toggle.getAttribute("aria-pressed") !== "true") return
            const link = previewLink(event.target, content)
            if (!link) return
            event.preventDefault()
            dismissed = null
            void open(link, true)
        }, { signal: events.signal, capture: true })
        toggle.addEventListener("click", () => {
            toggle.setAttribute("aria-pressed", String(toggle.getAttribute("aria-pressed") !== "true"))
        }, { signal: events.signal })
        for (const link of content.querySelectorAll<HTMLAnchorElement>("a[href]"))
            if (previewLink(link, content)) link.setAttribute("aria-keyshortcuts", shortcut)
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
            const target = event.target as Node
            if (panel.contains(target) || target === current || target === toggle) return
            if (current?.contains(target)) return
            const returnFocus = panel.contains(document.activeElement)
            const link = current
            dismissed = current
            close()
            if (returnFocus) link?.focus()
        }, { signal: events.signal })
        window.addEventListener("scroll", position, { signal: events.signal, passive: true, capture: true })
        window.addEventListener("resize", position, { signal: events.signal, passive: true })
        cleanup = () => { events.abort(); close(); panel.remove(); toggle.remove() }
    }
    document.addEventListener("astro:page-load", setup)
    document.addEventListener("astro:before-swap", () => cleanup())
    setup()
}
