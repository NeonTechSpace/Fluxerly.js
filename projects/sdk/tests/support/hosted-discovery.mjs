import assert from "node:assert/strict"

export const hostedDiscoveryUrl = "https://fluxer.app/.well-known/fluxer"

export const hostedDiscoveryDocument = Object.freeze({
    api_code_version: 1,
    endpoints: Object.freeze({
        api_public: "https://api.fluxer.app",
        gateway: "wss://gateway.fluxer.app",
        media: "https://fluxerusercontent.com",
        static_cdn: "https://fluxerstatic.com",
        webapp: "https://fluxer.app",
        invite: "https://fluxer.gg",
    }),
    features: Object.freeze({ presigned_attachment_uploads: true }),
})

function target(input) {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/** Serve the hosted bootstrap only for its exact URL and delegate every operation request to its fixture */
export function withHostedDiscovery(handler) {
    return async (input, init) => {
        const url = target(input)
        const options = init ?? {}
        if (url === hostedDiscoveryUrl) {
            assert.equal(options.method, "GET")
            assert.equal(options.redirect, "manual")
            assert.equal(new Headers(options.headers).has("authorization"), false)
            return Response.json(hostedDiscoveryDocument)
        }
        return handler(url, options)
    }
}
