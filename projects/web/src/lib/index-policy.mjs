// Single source of truth for pages kept out of sitemap.xml and marked noindex in HTML.
// Thin single-error-class stubs and near-duplicate Effect reference twins stay reachable for
// humans and in-site search without diluting search index quality, while Effect index pages
// and Effect-only services (FluxerClient and FluxerTestClient) stay indexable
const excluded = [
    /^\/?404\/?$/,
    /^\/?docs\/api\/(?:js-ts|testing)\/[^/]*error\/?$/i,
    /^\/?docs\/api\/effect\/(?!fluxerclient\/?$).+/i,
    /^\/?docs\/api\/effect-testing\/(?!fluxertestclient\/?$).+/i,
]

export function isExcludedFromSearch(path) {
    return excluded.some((pattern) => pattern.test(path))
}
