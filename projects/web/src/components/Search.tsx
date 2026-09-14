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

export default function Search({ version, ...props }: SharedProps & { version: string }) {
    const client = useMemo(() => staticClient({ from: `/api/search/${version}.json` }), [version])
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
                    <SearchDialogInput aria-label={`Search ${version === "dev" ? "Canary" : version} documentation`} />
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
