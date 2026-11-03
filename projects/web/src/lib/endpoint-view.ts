// What the endpoint map page shows of the generated data. The data keeps every route a bot or an OAuth2 application
// can be authorized for. The page keeps the ones a bot can actually send: a route with a Fluxerly method, or one that
// client.rest.request sends with the bot token. A route only a community's owner can send is shown with that note, so
// nobody takes its absence as a gap, and it isn't counted as one a bot can reach. Routes that need no token, a user's OAuth2 token, a webhook's token
// or a voice server's credential, and that no method sends, such as sign-in and billing, would only crowd the map. Areas come in order of how many of
// their routes have a method, so the areas a bot uses most come first

export interface ViewRoute {
    methods: unknown[]
    fallback?: string
}

export interface ViewArea<Route extends ViewRoute> {
    routes: Route[]
}

export function endpointView<Route extends ViewRoute, Area extends ViewArea<Route>>(areas: Area[]) {
    const sendable = (route: Route) => route.methods.length > 0 || route.fallback === "rest" || route.fallback === "ownerOnly"
    const shown = areas
        .map((area, index) => ({ area: { ...area, routes: area.routes.filter(sendable) }, index }))
        .filter(({ area }) => area.routes.length > 0)
    const withMethod = (area: Area) => area.routes.filter((route) => route.methods.length > 0).length
    shown.sort((a, b) => withMethod(b.area) - withMethod(a.area) || a.index - b.index)
    const rows = shown.flatMap(({ area }) => area.routes)
    const total = areas.reduce((sum, area) => sum + area.routes.length, 0)
    return {
        areas: shown.map(({ area }) => area),
        counts: {
            routes: rows.length,
            withMethod: rows.filter((route) => route.methods.length > 0).length,
            rest: rows.filter((route) => route.methods.length === 0 && route.fallback === "rest").length,
            hidden: total - rows.length,
        },
    }
}
