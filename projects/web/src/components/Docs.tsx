import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { DocsPage, type BreadcrumbProps, type DocsPageProps } from "fumadocs-ui/layouts/docs/page"
import { RootProvider } from "fumadocs-ui/provider/astro"
import type { Root } from "fumadocs-core/page-tree"
import type { AstroProviderProps } from "fumadocs-core/framework/astro"
import { Fragment, useEffect, useState, type ReactNode } from "react"
import { navigate } from "astro:transitions/client"
import { BooksIcon, CaretRightIcon } from "@phosphor-icons/react"
import { SidebarItem } from "fumadocs-ui/components/sidebar/base"
import type { SidebarPageTreeComponents } from "fumadocs-ui/components/sidebar/page-tree"
import Search from "./Search"
import type { Breadcrumb } from "../lib/docs-tree"
import { referenceEntries, referenceEntryForUrl } from "../../scripts/reference-entries.js"

type ReferenceCategories = Record<string, { title: string; anchor: string }[]>

// Category links differ from their entry point only by hash, which the server never sees, so the hash is undefined
// until the browser reads it. Same-page hash navigation does not always fire hashchange, so a category click also
// sets it directly
function useLocationHash() {
    const [hash, setHash] = useState<string>()
    useEffect(() => {
        const update = () => setHash(decodeURIComponent(location.hash.slice(1)))
        update()
        window.addEventListener("hashchange", update)
        window.addEventListener("popstate", update)
        return () => {
            window.removeEventListener("hashchange", update)
            window.removeEventListener("popstate", update)
        }
    }, [])
    return [hash, setHash] as const
}

export function Docs({
    tree,
    children,
    pathname,
    params,
    page,
    version,
    channelTabs,
    breadcrumbs,
    searchUrl,
    referenceCategories,
}: {
    tree: Root
    children: ReactNode
    pathname: string
    params: AstroProviderProps["params"]
    page: DocsPageProps
    version: string
    channelTabs: { label: string; url: string; active: boolean }[]
    breadcrumbs: Breadcrumb[]
    searchUrl: string
    referenceCategories: ReferenceCategories
}) {
    const currentPath = pathname.replace(/\/$/, "")
    // The server sends only the reference entries this sidebar renders
    const ReferenceFolder: SidebarPageTreeComponents["Folder"] = ({ item, children }) => {
        const [hash, setHash] = useLocationHash()
        const landing = item.index ?? item.children.find((child) => child.type === "page" && /\/api\/?$/.test(child.url))
        if (!landing || landing.type !== "page" || !/\/api\/?$/.test(landing.url)) return <>{children}</>
        const url = landing.url.replace(/\/$/, "")
        // Entries follow the reference entry point order. Released snapshots may lack later entry points
        const entries = item.children
            .flatMap((child) => (child.type === "folder" ? child.children : [child]))
            .flatMap((child) => {
                const entry = child.type === "page" ? referenceEntryForUrl(child.url) : undefined
                if (!entry || child.type !== "page") return []
                // A lone category covers the whole entry point, so its link would only repeat the entry
                const categories = referenceCategories[entry.name] ?? []
                return [{ url: child.url, entry, categories: categories.length > 1 ? categories : [] }]
            })
            .sort((left, right) => referenceEntries.indexOf(left.entry) - referenceEntries.indexOf(right.entry))
        // Exactly one link is active: the selected category, else the entry point owning the page or its symbol
        // pages such as interfaces/js-ts.Messages, else the reference landing for other reference pages
        const here = (target: string) => currentPath === target.replace(/\/$/, "")
        const symbolPath = currentPath.startsWith(`${url}/`) ? currentPath.slice(url.length + 1) : ""
        const owner = entries.find(({ url, entry }) => here(url) || new RegExp(`^[a-z]+/${entry.name}[.]`).test(symbolPath))
        const onEntryPage = owner !== undefined && here(owner.url)
        const category = onEntryPage ? owner.categories.find((category) => category.anchor === hash) : undefined
        // On an entry point page neither the entry nor a category is current until the hash is known. Marking the
        // entry first would make the sidebar scroll to it and away from the category link just clicked
        const entryActive = owner !== undefined && (!onEntryPage || (hash !== undefined && !category))
        return (
            <div className="reference-nav">
                <SidebarItem href={url} active={currentPath === url || (symbolPath !== "" && !owner)}
                    className="reference-nav-link">
                    API reference
                </SidebarItem>
                {entries.map(({ url, entry, categories }) => (
                    <Fragment key={url}>
                        <SidebarItem href={url} active={owner?.url === url && entryActive}
                            onClick={() => here(url) && setHash("")} className="reference-nav-link reference-nav-entry">
                            {entry.title}
                        </SidebarItem>
                        {/* Another entry point can have a category with the same anchor, so only this page's links set it */}
                        {categories.map((link) => (
                            <SidebarItem key={link.anchor} href={`${url}#${link.anchor}`}
                                active={owner?.url === url && category === link} onClick={() => here(url) && setHash(link.anchor)}
                                className="reference-nav-link reference-nav-category">
                                {link.title}
                                {/* Entry points share category names, so link names carry their entry point for link lists */}
                                <span className="sr-only"> ({entry.title})</span>
                            </SidebarItem>
                        ))}
                    </Fragment>
                ))}
            </div>
        )
    }
    // Deep symbol pages are absent from the browser tree, so breadcrumbs are resolved during the build
    const PageBreadcrumbs = ({ includeRoot: _root, includePage: _page, includeSeparator: _separator, ...props }: BreadcrumbProps) =>
        breadcrumbs.length === 0 ? null : (
            <nav aria-label="Breadcrumb" {...props} className={`flex items-center gap-1.5 text-sm text-fd-muted-foreground ${props.className ?? ""}`}>
                {breadcrumbs.map((item, index) => (
                    <Fragment key={index}>
                        {index > 0 && <CaretRightIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                        {item.url
                            ? <a href={item.url} className={`truncate transition-opacity hover:opacity-80${index === breadcrumbs.length - 1 ? " text-fd-primary font-medium" : ""}`}>{item.name}</a>
                            : <span className={`truncate${index === breadcrumbs.length - 1 ? " text-fd-primary font-medium" : ""}`}>{item.name}</span>}
                    </Fragment>
                ))}
            </nav>
        )
    return (
        <RootProvider
            pathname={pathname}
            params={params}
            navigate={navigate}
            theme={{ enabled: false }}
            search={{ SearchDialog: (props) => <Search {...props} version={version} from={searchUrl} /> }}
        >
            <DocsLayout
                tree={tree}
                tabs={channelTabs.map((tab) => ({ title: tab.label, url: tab.url, urls: new Set(tab.active ? [pathname.replace(/\/$/, "")] : []) }))}
                sidebar={{ components: { Folder: ReferenceFolder } }}
                themeSwitch={{ enabled: false }}
                nav={{
                    title: (
                        <>
                            <BooksIcon weight="duotone" aria-hidden="true" />
                            Fluxerly.js
                        </>
                    ),
                    url: "/",
                }}
            >
                <DocsPage {...page} slots={{ breadcrumb: PageBreadcrumbs }}>{children}</DocsPage>
            </DocsLayout>
        </RootProvider>
    )
}
