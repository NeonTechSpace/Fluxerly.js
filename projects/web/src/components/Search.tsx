import {
    SearchDialog,
    SearchDialogClose,
    SearchDialogContent,
    SearchDialogHeader,
    SearchDialogIcon,
    SearchDialogInput,
    SearchDialogList,
    SearchDialogListItem,
    SearchDialogOverlay,
    type SharedProps,
} from "fumadocs-ui/components/dialog/search"
import { useDocsSearch } from "fumadocs-core/search/client"
import { staticClient } from "fumadocs-core/search/client/orama-static"
import { useMemo, useRef } from "react"
import { rankResults, searchOptions } from "../lib/search-options"

export default function Search({ version, from, ...props }: SharedProps & { version: string; from: string }) {
    const client = useMemo(() => {
        const base = staticClient({ from, search: searchOptions })
        return { ...base, search: async (query: string) => rankResults(query, await base.search(query)) }
    }, [from])
    const { search, setSearch, query } = useDocsSearch({ client })
    const returnFocus = useRef<HTMLElement | null>(null)
    return (
        <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
            <SearchDialogOverlay />
            <SearchDialogContent
                onOpenAutoFocus={() => {
                    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
                }}
                onCloseAutoFocus={(event) => {
                    if (returnFocus.current?.isConnected) {
                        event.preventDefault()
                        returnFocus.current.focus({ preventScroll: true })
                    }
                }}
            >
                <SearchDialogHeader>
                    <SearchDialogIcon />
                    <SearchDialogInput
                        aria-label={`Search ${version === "preview" ? "source preview" : version === "rc" ? "RC" : version === "canary" ? "Canary" : version} documentation`}
                    />
                    <SearchDialogClose />
                </SearchDialogHeader>
                <SearchDialogList
                    items={query.data !== "empty" ? query.data : null}
                    Item={(itemProps) => (
                        <SearchDialogListItem
                            {...itemProps}
                            className={itemProps.item.type === "text" ? "search-excerpt" : undefined}
                        />
                    )}
                />
            </SearchDialogContent>
        </SearchDialog>
    )
}
