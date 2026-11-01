// Typed access to the endpoint map that scripts/docs/endpoints.mjs writes: Fluxer's HTTP routes a bot can use, grouped
// by the Fluxer docs page that describes them, each with the Fluxerly methods that send it
import endpointsSource from "@content/reference/endpoints.json?raw"

/** What a reader can use when no Fluxerly method sends a route */
export type EndpointFallback = "rest" | "noToken" | "oauth2" | "webhookToken"

export interface EndpointRoute {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    path: string
    summary: string
    /** The route's section in Fluxer's docs */
    docs: string | null
    methods: { name: string; url: string }[]
    fallback?: EndpointFallback
}

export interface EndpointArea {
    title: string
    slug: string
    url: string | null
    routes: EndpointRoute[]
}

export interface Endpoints {
    source: {
        fluxer: { repository: string; commit: string; openapi: string; sha256: string }
        docs: string
        sdk: { version: string; commit: string | null }
    }
    leftOut: { userSession: number; admin: number }
    rest: { name: string; url: string }
    counts: { routes: number; withMethod: number; rest: number; noToken: number; oauth2: number; webhookToken: number }
    areas: EndpointArea[]
}

export const endpoints: Endpoints = JSON.parse(endpointsSource)

/** A route's anchor on the page, such as get-channels-channel-id-messages */
export const routeId = (route: Pick<EndpointRoute, "method" | "path">) =>
    `${route.method}${route.path}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
