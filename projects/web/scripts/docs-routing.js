// This module is also emitted into the Cloudflare Pages worker
const prereleaseVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:canary|rc)\.(?:0|[1-9]\d*)$/
function unpublishedDocsPath(path) {
    let decoded
    try { decoded = decodeURIComponent(path) } catch { decoded = path }
    const parts = /^\/docs\/([^/]+)(?:\/([^/]+))?/.exec(decoded)
    return parts !== null && (prereleaseVersion.test(parts[1]) || parts[2] === "migration")
}
export function docsRedirect(request, routes, root = "/docs/latest/") {
    if (request.method !== "GET" && request.method !== "HEAD") return null
    const url = new URL(request.url)
    const path = url.pathname
    if (path !== "/" && path !== "/docs" && !path.startsWith("/docs/")) return null
    if (unpublishedDocsPath(path)) return null
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
    // Reject ambiguous encodings rather than interpreting them as another page
    if (!decoded || /[%\\\x00-\x1f\x7f]/.test(decoded) || /%2f|%5c/i.test(path) || decoded.includes("//")) {
        const rawVersion = /^\/docs\/([^/]+)(?:\/|$)/.exec(path)?.[1]
        const channel = rawVersion === "canary" || rawVersion === "rc" ? rawVersion : null
        if (channel) return routes.has(`/docs/${channel}`) ? `/docs/${channel}/` + url.search : null
        return root + url.search
    }
    const canonical = decoded.replace(/\/$/, "")
    const parts = canonical.slice("/docs/".length).split("/")
    const version = parts[0]
    const channel = version === "canary" || version === "rc" ? version : null
    if (channel) {
        const channelRoot = `/docs/${channel}`
        // A channel that was not emitted must remain a 404, never a Stable fallback
        if (!routes.has(channelRoot)) return null
        if (routes.has(canonical)) return null
        return `${channelRoot}/` + url.search
    }
    if (routes.has(canonical)) return null
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
            // Asset storage can still return cached files removed by a newer deployment
            if (unpublishedDocsPath(new URL(request.url).pathname)) return new Response("Not found", {
                status: 404,
                headers: {
                    "cache-control": "no-store",
                    "content-type": "text/plain; charset=utf-8",
                    "x-robots-tag": "noindex, nofollow",
                    "x-content-type-options": "nosniff",
                },
            })
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
