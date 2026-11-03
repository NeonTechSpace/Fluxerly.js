// The Fluxer commit a docs version was checked against. Each version reads it from its own endpoint map, which
// scripts/docs/endpoints.mjs writes from projects/release/upstream/manifest.json and every snapshot holds, so a published
// version shows the pin it was made with and a local build shows the working tree's

export interface FluxerPin {
    commit: string
    /** The commit's first seven characters, the way GitHub shortens it */
    short: string
    url: string
}

/** The pin from an endpoint map's `source`, or null when the map names no valid one, so the page shows nothing rather than a wrong link */
export function fluxerPinOf(source: unknown): FluxerPin | null {
    const fluxer = (source as { fluxer?: { repository?: unknown; commit?: unknown } } | undefined)?.fluxer
    const repository = fluxer?.repository
    const commit = fluxer?.commit
    if (typeof repository !== "string" || typeof commit !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) return null
    return { commit, short: commit.slice(0, 7), url: `https://github.com/${repository}/commit/${commit}` }
}
