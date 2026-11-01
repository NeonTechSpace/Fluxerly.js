import { getCollection } from "astro:content"
import inventory from "@content/guides/meta.json"
import { titleCase } from "./title-case"
import { codesUrl, endpointsUrl, isReexport, model, referenceUrl, tasksUrl, type Declaration } from "./reference"

export interface NavItem {
    title: string
    href: string
    current?: boolean
    items?: NavItem[]
}

export interface NavGroup {
    title: string
    href?: string
    items: NavItem[]
}

export interface TocItem {
    depth: 2 | 3
    text: string
    id: string
}

// One station of a part's course: a group that opens and closes. The current page's group starts open
export interface CourseGroup {
    id: string
    title: string
    items: NavItem[]
    current: boolean
}

// The two halves of the docs. Guides are what you do, reference is what the SDK knows
export interface CoursePart {
    id: "guides" | "reference"
    title: string
    tone: "cyan" | "violet"
    groups: CourseGroup[]
    current: boolean
}

type InventoryItem = string | { title: string; href: string }

export const guideHref = (slug: string) => (slug === "index" ? "/docs/" : `/docs/${slug}/`)

const slugify = (title: string) =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")

const holdsCurrent = (items: NavItem[]): boolean => items.some((item) => item.current || holdsCurrent(item.items ?? []))

// The guide groups in inventory order, titled by each guide's navTitle
export async function guideNav(current: string): Promise<NavGroup[]> {
    const titles = new Map((await getCollection("guides")).map((entry) => [entry.id, entry.data.navTitle ?? entry.data.title]))
    return inventory.groups.map((group) => ({
        title: titleCase(group.title),
        items: (group.items as InventoryItem[]).map((item) => {
            const href = typeof item === "string" ? guideHref(item) : item.href
            const title = typeof item === "string" ? (titles.get(item) ?? item) : titleCase(item.title)
            return { title, href, current: href === current }
        }),
    }))
}

// The reference course: its front door, then one station per entry point with every category. A category lists its
// class pages only while the reader is inside it, so the Errors category's long list stays out of the way elsewhere
function referenceGroups(current: string): CourseGroup[] {
    const item = (title: string, href: string, items?: NavItem[]): NavItem => ({
        title,
        href,
        ...(href === current ? { current: true } : {}),
        ...(items?.length ? { items } : {}),
    })
    const start = [item("Overview", referenceUrl), item("Find a Method by Task", tasksUrl), item("Fluxer Endpoints", endpointsUrl), item("Error and Log Codes", codesUrl)]
    const entries = model.entries.map((entry) => {
        const items = [
            item("Overview", entry.url),
            ...entry.categories.map((category) => {
                const pages = category.items.filter((candidate): candidate is Declaration => !isReexport(candidate) && !!candidate.page)
                const inside = current === category.url || pages.some((declaration) => declaration.url === current)
                return item(category.title, category.url, inside ? pages.map((declaration) => item(declaration.name, declaration.url)) : undefined)
            }),
        ]
        return { id: `reference-${entry.key}`, title: entry.title, items, current: holdsCurrent(items) }
    })
    return [{ id: "reference-start", title: "API Reference", items: start, current: holdsCurrent(start) }, ...entries]
}

// Both parts of the docs for one page. The page's own part is the one the sidebar shows first
export async function docsCourse(current: string, section: "guides" | "reference" | "codes"): Promise<CoursePart[]> {
    const guides = (await guideNav(current)).map((group) => ({ id: `guides-${slugify(group.title)}`, title: group.title, items: group.items, current: holdsCurrent(group.items) }))
    return [
        { id: "guides", title: "Guides", tone: "cyan", groups: guides, current: section === "guides" },
        { id: "reference", title: "Reference", tone: "violet", groups: referenceGroups(current), current: section !== "guides" },
    ]
}

// The group a guide belongs to, for search results
export function guideGroup(slug: string): string | undefined {
    return inventory.groups.find((group) => (group.items as InventoryItem[]).includes(slug))?.title
}
