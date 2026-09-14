import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { DocsPage, type DocsPageProps } from "fumadocs-ui/layouts/docs/page"
import { RootProvider } from "fumadocs-ui/provider/astro"
import type { Root } from "fumadocs-core/page-tree"
import type { AstroProviderProps } from "fumadocs-core/framework/astro"
import type { ReactNode } from "react"
import { navigate } from "astro:transitions/client"
import { BooksIcon } from "@phosphor-icons/react"
import { SidebarItem } from "fumadocs-ui/components/sidebar/base"
import type { SidebarPageTreeComponents } from "fumadocs-ui/components/sidebar/page-tree"
import Search from "./Search"

export function Docs({
    tree,
    children,
    pathname,
    params,
    page,
    version,
    channelTabs,
}: {
    tree: Root
    children: ReactNode
    pathname: string
    params: AstroProviderProps["params"]
    page: DocsPageProps
    version: string
    channelTabs: { label: string; url: string; active: boolean }[]
}) {
    // Only the sidebar is condensed, so search, breadcrumbs and version matching retain every symbol
    const ReferenceFolder: SidebarPageTreeComponents["Folder"] = ({ item, children }) => {
        if (!item.index || !/\/api\/?$/.test(item.index.url)) return <>{children}</>
        const url = item.index.url.replace(/\/$/, "")
        const entries = item.children
            .flatMap((child) => (child.type === "folder" ? child.children : [child]))
            .filter((child) => child.type === "page" && /\/modules\/(js-ts|Effect)\/?$/.test(child.url))
            .sort((left, right) => Number(left.type === "page" && left.url.includes("/Effect")) - Number(right.type === "page" && right.url.includes("/Effect")))
        return (
            <div className="reference-nav">
                <SidebarItem href={url} active={pathname === url || pathname.startsWith(`${url}/`)}
                    className="reference-nav-link">
                    API reference
                </SidebarItem>
                {entries.map((entry) => entry.type === "page" && (
                    <SidebarItem key={entry.url} href={entry.url} className="reference-nav-link reference-nav-entry">
                        {entry.url.includes("/js-ts") ? "JavaScript & TypeScript" : "Effect-native"}
                    </SidebarItem>
                ))}
            </div>
        )
    }
    return (
        <RootProvider
            pathname={pathname}
            params={params}
            navigate={navigate}
            theme={{ enabled: false }}
            search={{ SearchDialog: (props) => <Search {...props} version={version} /> }}
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
                <DocsPage {...page}>{children}</DocsPage>
            </DocsLayout>
        </RootProvider>
    )
}
