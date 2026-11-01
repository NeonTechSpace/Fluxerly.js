import snapshot from "../../data/npm-downloads.json"

// The address the chart asks for the newest download history. In production the Cloudflare Pages Function in
// functions/api/npm-downloads.ts answers it, because a function runs before the static files at its route.
// This file only answers under astro dev and a plain static serve, with the snapshot the build drew, so the
// chart stays as it is and no request fails
export function GET() {
    return new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } })
}
