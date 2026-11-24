import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { buildSitemap, sitemapPaths } from "../scripts/sitemap.mjs"
import { featurePages } from "../src/lib/links.ts"
import { faqFromMarkdown, faqGraph, featurePageGraph, homeGraph, techArticleGraph } from "../src/lib/seo.ts"

test("sitemap focuses on rich unique pages and uses lastmod instead of changefreq", () => {
    const sample = [
        "",
        "404/",
        "commands/",
        "docs/",
        "docs/quick-start/",
        "docs/api/",
        "docs/api/tasks/",
        "docs/api/endpoints/",
        "docs/api/js-ts/",
        "docs/api/js-ts/client/",
        "docs/api/js-ts/errors/",
        "docs/api/js-ts/ratelimiterror/",
        "docs/api/testing/",
        "docs/api/testing/testing/",
        "docs/api/testing/unhandledtestfailureserror/",
        "docs/api/effect/",
        "docs/api/effect/client/",
        "docs/api/effect-testing/",
        "docs/api/effect-testing/testing/",
        "llms.txt",
        "SKILL.md",
    ]
    const kept = sitemapPaths(sample)
    assert.deepEqual(kept, [
        "",
        "commands/",
        "docs/",
        "docs/api/",
        "docs/api/effect-testing/",
        "docs/api/effect/",
        "docs/api/endpoints/",
        "docs/api/js-ts/",
        "docs/api/js-ts/client/",
        "docs/api/js-ts/errors/",
        "docs/api/tasks/",
        "docs/api/testing/",
        "docs/api/testing/testing/",
        "docs/quick-start/",
    ])
    const xml = buildSitemap("https://fluxerly.neontechspace.com", sample, "2026-11-24")
    assert.match(xml, /<loc>https:\/\/fluxerly\.neontechspace\.com\/docs\/quick-start\/<\/loc><lastmod>2026-11-24<\/lastmod>/)
    assert.doesNotMatch(xml, /<changefreq>/)
})

test("structured data includes alternate brand names, version and helpers", () => {
    const website = homeGraph.find((node) => node["@type"] === "WebSite")
    const sdk = homeGraph.find((node) => node["@type"] === "SoftwareSourceCode")
    const org = homeGraph.find((node) => node["@type"] === "Organization")
    assert.deepEqual(website?.alternateName, ["Fluxerly", "FluxerlyJS", "@neontechspace/fluxerly"])
    assert.deepEqual(sdk?.alternateName, ["Fluxerly", "FluxerlyJS", "@neontechspace/fluxerly"])
    assert.ok(typeof sdk?.softwareVersion === "string" && sdk.softwareVersion.length > 0)
    assert.ok(Array.isArray(org?.sameAs) && org.sameAs.length >= 2)

    const article = techArticleGraph({ title: "Start a Bot", description: "Send !ping", path: "/docs/quick-start/" })
    assert.equal(article["@type"], "TechArticle")
    assert.equal(article.url, "https://fluxerly.neontechspace.com/docs/quick-start/")

    const featureNodes = featurePageGraph({ title: "Commands with the Plumbing Done", description: "Prefix commands", path: "/commands/" })
    assert.equal(featureNodes.length, 2)
    assert.equal(featureNodes[0]?.["@type"], "WebPage")
    assert.equal(featureNodes[1]?.["@type"], "BreadcrumbList")
})

test("FAQ guide parses into a valid FAQPage structured data graph", () => {
    const source = readFileSync(new URL("../content/guides/faq.md", import.meta.url), "utf8")
    const items = faqFromMarkdown(source)
    assert.ok(items.length >= 10)
    for (const item of items) {
        assert.ok(item.question.endsWith("?"), item.question)
        assert.ok(item.answer.length > 20, item.question)
        assert.doesNotMatch(item.answer, /\[[^\]]+\]\([^)]+\)/)
    }
    const node = faqGraph(items)
    assert.equal(node?.["@type"], "FAQPage")
    assert.equal((node?.mainEntity as unknown[])?.length, items.length)
})

test("feature page SEO metadata stays Fluxer-native and follows prose rules", () => {
    for (const page of featurePages) {
        assert.ok(page.seoTitle.includes("Fluxerly.js"), page.slug)
        assert.ok(page.seoDescription.length >= 100 && page.seoDescription.length <= 160, `${page.slug}: ${page.seoDescription.length}`)
        assert.doesNotMatch(page.seoDescription, /[\u2014;]|\.$/)
    }
})

test("public _headers does not apply noindex to the root wildcard", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
    assert.doesNotMatch(headers, /^\/\*\s*\r?\n(?:[ \t]+[^\r\n]*\r?\n?)*?[ \t]+x-robots-tag\s*:[^\r\n]*noindex/im)
    for (const route of ["/llms.txt", "/llms-full.txt", "/SKILL.md", "/docs/*.md", "/docs/api/*.md", "/docs/*.txt"]) {
        assert.ok(headers.includes(`${route}\n  X-Robots-Tag: noindex`), `missing noindex rule for ${route}`)
    }
})
