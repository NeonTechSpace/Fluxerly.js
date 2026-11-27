import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { siteOrigin } from "./deploy.js"

export const indexNowEndpoint = "https://api.indexnow.org/indexnow"
export const indexNowKey = "4889a7c8908f587d9229d40b7b5b75e0"

const defaultDistDir = fileURLToPath(new URL("../dist", import.meta.url))
const validKeyPattern = /^[a-f0-9]{32}$/
const maxUrlsPerRequest = 10_000

export function parseSitemapUrls(xml, origin = siteOrigin) {
    const expectedOrigin = new URL(origin).origin
    const urls = []
    const seen = new Set()
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const raw = match[1]?.trim()
        if (!raw) continue
        let parsed
        try {
            parsed = new URL(raw)
        } catch {
            continue
        }
        if (parsed.origin !== expectedOrigin) continue
        if (seen.has(parsed.href)) continue
        seen.add(parsed.href)
        urls.push(parsed.href)
    }
    if (!urls.length) throw new Error("No site URLs were found in dist/sitemap.xml")
    if (urls.length > maxUrlsPerRequest)
        throw new Error(`Sitemap URL count ${urls.length} exceeds the IndexNow limit of ${maxUrlsPerRequest}`)
    return urls
}

export async function readIndexNowKey(keyFilePath, expectedKey = indexNowKey, io = {}) {
    const read = io.readFile ?? readFile
    const content = await read(keyFilePath, "utf8")
    if (!validKeyPattern.test(content) || content !== expectedKey)
        throw new Error("The built IndexNow key file does not match the configured key")
    return content
}

export function buildIndexNowPayload(origin, key, urls) {
    const parsedOrigin = new URL(origin)
    return {
        host: parsedOrigin.host,
        key,
        keyLocation: new URL(`/${key}.txt`, parsedOrigin.origin).href,
        urlList: urls,
    }
}

export async function submitIndexNow(options = {}, io = {}) {
    const origin = options.origin ?? siteOrigin
    const key = options.key ?? indexNowKey
    const endpoint = options.endpoint ?? indexNowEndpoint
    const distDir = options.distDir ?? defaultDistDir
    const timeoutMs = options.timeoutMs ?? 15_000
    const read = io.readFile ?? readFile
    const request = io.fetch ?? fetch

    const verifiedKey = await readIndexNowKey(join(distDir, `${key}.txt`), key, { readFile: read })
    const sitemapXml = await read(join(distDir, "sitemap.xml"), "utf8")
    const urls = parseSitemapUrls(sitemapXml, origin)
    const payload = buildIndexNowPayload(origin, verifiedKey, urls)

    const response = await request(endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
    })

    if (response.status !== 200 && response.status !== 202) {
        const body = (await response.text().catch(() => "")).trim().slice(0, 200)
        const suffix = body ? ` (${body})` : ""
        throw new Error(`IndexNow rejected the notification with HTTP ${response.status}${suffix}`)
    }

    return {
        status: response.status,
        urlCount: urls.length,
        host: payload.host,
        keyLocation: payload.keyLocation,
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = await submitIndexNow()
        if (process.env.GITHUB_OUTPUT) {
            await appendFile(
                process.env.GITHUB_OUTPUT,
                `status=submitted\nurl_count=${result.urlCount}\nhttp_status=${result.status}\n`,
            )
        }
        console.log(`IndexNow accepted ${result.urlCount} URLs for ${result.host} (HTTP ${result.status})`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (process.env.GITHUB_OUTPUT) {
            await appendFile(process.env.GITHUB_OUTPUT, "status=failed\n")
        }
        console.error(`IndexNow notification failed: ${message}`)
        process.exitCode = 1
    }
}
