// This module is also emitted into the Cloudflare Pages worker
export function docsRedirect(request, routes, root = "/docs/latest/") {
    if (request.method !== "GET" && request.method !== "HEAD") return null
    const url = new URL(request.url)
    const path = url.pathname
    if (path !== "/" && path !== "/docs" && !path.startsWith("/docs/")) return null
    const destination = request.headers.get("sec-fetch-dest")
    if (destination && destination !== "document" && destination !== "iframe" && destination !== "empty") return null
    const accept = request.headers.get("accept")
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return null

    let decoded
    try { decoded = decodeURIComponent(path) } catch { decoded = null }
    // Dotted SDK versions are not file extensions. Reference /api/ paths are pages
    const asset = /\.(?:js|mjs|cjs|css|json|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|pdf|txt|xml|wasm|zip)$/i
    if (asset.test(decoded ?? path) || /\/(?:_astro|assets|_image|search)(?:\/|$)/.test(decoded ?? path)) return null
    if (path === "/" || path === "/docs" || path === "/docs/") return root + url.search
    // Reject ambiguous encodings rather than interpreting them as another route
    if (!decoded || /[%\\\x00-\x1f\x7f]/.test(decoded) || /%2f|%5c/i.test(path) || decoded.includes("//")) return root + url.search
    const canonical = decoded.replace(/\/$/, "")
    if (routes.has(canonical)) return null
    const parts = canonical.slice("/docs/".length).split("/")
    const suffix = parts.slice(1).join("/")
    const candidates = new Set([
        ...(suffix ? [`${root}${suffix}`.replace(/\/$/, "")] : []),
        `${root}${parts.join("/")}`.replace(/\/$/, ""),
    ].filter((candidate) => routes.has(candidate)))
    const target = candidates.size === 1 ? [...candidates][0] : root
    return encodeURI(target.replace(/\/?$/, "/")) + url.search
}

export function createDocsHandler(pages) {
    const routes = new Set(pages)
    const root = routes.has("/docs/latest") ? "/docs/latest/" : "/docs/preview/"
    if (!routes.has(root.slice(0, -1))) throw new Error("Documentation root is missing")
    return {
        async fetch(request, env) {
            const target = docsRedirect(request, routes, root)
            if (target) return new Response(null, {
                status: 302,
                headers: {
                    location: target,
                    "cache-control": "no-store",
                    "x-robots-tag": "noindex, nofollow",
                    "x-content-type-options": "nosniff",
                    "referrer-policy": "strict-origin-when-cross-origin",
                },
            })
            return env.ASSETS.fetch(request)
        },
    }
}
