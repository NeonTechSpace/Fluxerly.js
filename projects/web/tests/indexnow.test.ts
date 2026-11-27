import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
    buildIndexNowPayload,
    indexNowEndpoint,
    indexNowKey,
    parseSitemapUrls,
    readIndexNowKey,
    submitIndexNow,
} from "../scripts/indexnow.mjs"

test("public IndexNow key file matches configured key and carries a noindex header", () => {
    const keyFile = readFileSync(new URL(`../public/${indexNowKey}.txt`, import.meta.url), "utf8")
    assert.equal(keyFile, indexNowKey)
    assert.match(keyFile, /^[a-f0-9]{32}$/)

    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
    assert.ok(headers.includes(`/${indexNowKey}.txt\n  X-Robots-Tag: noindex`))
})

test("parseSitemapUrls keeps unique same-origin URLs and rejects empty sitemaps", () => {
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        "    <url><loc>https://fluxerly.neontechspace.com/</loc><lastmod>2026-11-27</lastmod></url>",
        "    <url><loc>https://fluxerly.neontechspace.com/docs/</loc><lastmod>2026-11-27</lastmod></url>",
        "    <url><loc>https://fluxerly.neontechspace.com/docs/</loc><lastmod>2026-11-27</lastmod></url>",
        "    <url><loc>https://example.com/foreign/</loc></url>",
        "</urlset>",
    ].join("\n")

    assert.deepEqual(parseSitemapUrls(xml, "https://fluxerly.neontechspace.com"), [
        "https://fluxerly.neontechspace.com/",
        "https://fluxerly.neontechspace.com/docs/",
    ])

    assert.throws(
        () => parseSitemapUrls("<urlset></urlset>", "https://fluxerly.neontechspace.com"),
        /No site URLs were found/,
    )
})

test("buildIndexNowPayload formats host, key, keyLocation and urlList", () => {
    const payload = buildIndexNowPayload("https://fluxerly.neontechspace.com", indexNowKey, [
        "https://fluxerly.neontechspace.com/",
        "https://fluxerly.neontechspace.com/docs/",
    ])
    assert.deepEqual(payload, {
        host: "fluxerly.neontechspace.com",
        key: indexNowKey,
        keyLocation: `https://fluxerly.neontechspace.com/${indexNowKey}.txt`,
        urlList: [
            "https://fluxerly.neontechspace.com/",
            "https://fluxerly.neontechspace.com/docs/",
        ],
    })
})

test("submitIndexNow posts sitemap URLs after verifying built key file and handles HTTP status codes", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "fluxerly-indexnow-"))
    try {
        writeFileSync(join(distDir, `${indexNowKey}.txt`), indexNowKey)
        writeFileSync(
            join(distDir, "sitemap.xml"),
            '<urlset><url><loc>https://fluxerly.neontechspace.com/</loc></url><url><loc>https://fluxerly.neontechspace.com/docs/</loc></url></urlset>',
        )

        const requests: Array<{ url: string; init: { method?: string; body?: string } }> = []
        const mockFetch = async (url: string, init: { method?: string; body?: string }) => {
            requests.push({ url, init })
            return new Response("", { status: 202 })
        }

        const result = await submitIndexNow({ distDir }, { fetch: mockFetch })
        assert.deepEqual(result, {
            status: 202,
            urlCount: 2,
            host: "fluxerly.neontechspace.com",
            keyLocation: `https://fluxerly.neontechspace.com/${indexNowKey}.txt`,
        })
        assert.equal(requests.length, 1)
        assert.equal(requests[0]?.url, indexNowEndpoint)
        assert.equal(requests[0]?.init.method, "POST")
        assert.deepEqual(JSON.parse(requests[0]?.init.body ?? "{}"), {
            host: "fluxerly.neontechspace.com",
            key: indexNowKey,
            keyLocation: `https://fluxerly.neontechspace.com/${indexNowKey}.txt`,
            urlList: [
                "https://fluxerly.neontechspace.com/",
                "https://fluxerly.neontechspace.com/docs/",
            ],
        })

        await assert.rejects(
            () => submitIndexNow({ distDir }, { fetch: async () => new Response("Invalid key", { status: 422 }) }),
            /HTTP 422 \(Invalid key\)/,
        )

        writeFileSync(join(distDir, `${indexNowKey}.txt`), "wrong-key")
        await assert.rejects(
            () => readIndexNowKey(join(distDir, `${indexNowKey}.txt`), indexNowKey),
            /does not match/,
        )
    } finally {
        rmSync(distDir, { recursive: true, force: true })
    }
})
