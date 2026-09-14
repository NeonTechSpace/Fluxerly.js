import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL, fileURLToPath } from "node:url"

export function previewSettings(env) {
    const account = env.CLOUDFLARE_ACCOUNT_ID
    const project = env.CLOUDFLARE_PAGES_PROJECT
    const token = env.CLOUDFLARE_API_TOKEN
    const origin = env.CLOUDFLARE_PREVIEW_URL
    if (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-z0-9][a-z0-9-]*$/.test(project ?? "") || !token)
        throw new Error("Configure the Cloudflare account, Pages project and API token")
    let url
    try {
        url = new URL(origin)
    } catch {
        throw new Error("Configure the public preview.* URL")
    }
    if (
        url.protocol !== "https:" ||
        !url.hostname.startsWith("preview.") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.port
    )
        throw new Error("The preview URL must be an HTTPS preview.* origin")
    return { account, project, token, origin: url.origin, branch: "preview" }
}

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const deploymentId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const noindex = (value) => /(?:^|[\s,:])noindex(?:$|[\s,])/i.test(value ?? "")

async function upload(settings, source) {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve("wrangler/package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.wrangler
    const temporary = await mkdtemp(join(tmpdir(), "fluxerly-preview-"))
    const output = join(temporary, "output.ndjson")
    try {
        // Keep provider output and exception details out of CI logs, including on failure
        try {
            execFileSync(
                process.execPath,
                [
                    join(dirname(manifestPath), bin),
                    "pages",
                    "deploy",
                    "dist",
                    "--project-name",
                    settings.project,
                    "--branch",
                    settings.branch,
                    "--commit-hash",
                    source,
                    "--commit-dirty=false",
                ],
                {
                    cwd: webRoot,
                    stdio: "ignore",
                    timeout: 300_000,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        CLOUDFLARE_ACCOUNT_ID: settings.account,
                        CLOUDFLARE_API_TOKEN: settings.token,
                        WRANGLER_OUTPUT_FILE_PATH: output,
                        WRANGLER_SEND_METRICS: "false",
                    },
                },
            )
        } catch {
            /* Read a recorded deployment identity before deciding the outcome */
        }
        let record
        try {
            record = (await readFile(output, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
                .find((item) => item.type === "pages-deploy" && item.version === 1)
        } catch {
            /* No recorded identity means the upload outcome is unknown */
        }
        if (record?.pages_project !== settings.project || !deploymentId.test(record?.deployment_id ?? "")) {
            throw new Error(
                "Upload outcome is unknown; reconcile this source and branch in Cloudflare before another upload",
            )
        }
        return record.deployment_id
    } finally {
        if (dirname(temporary) !== resolve(tmpdir())) throw new Error("Unexpected temporary preview directory")
        await rm(temporary, { recursive: true, force: true })
    }
}

class ReadUnavailable extends Error {}

export async function deployPreview(env = process.env, io = {}) {
    const settings = previewSettings(env)
    const source = env.DOCS_SOURCE_COMMIT
    if (!/^[a-f0-9]{40}$/.test(source ?? "")) throw new Error("A verified source commit is required")
    const read = io.readFile ?? readFile
    const request = io.fetch ?? fetch
    const publish = io.upload ?? upload
    const now = io.now ?? Date.now
    const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    let marker, headers
    try {
        marker = JSON.parse(await read(join(webRoot, "dist/deployment.json"), "utf8"))
        headers = await read(join(webRoot, "dist/_headers"), "utf8")
    } catch {
        throw new Error("Build the checked preview and record its source marker before upload")
    }
    if (marker?.sourceCommit !== source) throw new Error("The local preview marker does not match the checked source")
    const globalHeaders = headers.match(/^\/\*\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/m)?.[1]
    if (!globalHeaders?.split(/\r?\n/).some((line) => /^\s+x-robots-tag\s*:/i.test(line) && noindex(line)))
        throw new Error("The built preview requires a global noindex header")
    const base = `https://api.cloudflare.com/client/v4/accounts/${settings.account}/pages/projects/${settings.project}`
    async function get(url, authenticated, timeout) {
        let response
        try {
            response = await request(url, {
                headers: authenticated ? { Authorization: `Bearer ${settings.token}` } : {},
                signal: AbortSignal.timeout(timeout),
                redirect: "error",
                cache: "no-store",
            })
        } catch {
            throw new ReadUnavailable("Cloudflare preview read is unavailable")
        }
        if ([408, 429].includes(response.status) || response.status >= 500) {
            const error = new ReadUnavailable(`Cloudflare readback failed with HTTP ${response.status}`)
            const retryAfter = response.headers.get("retry-after")
            error.retryAfter =
                retryAfter == null
                    ? 0
                    : /^\d+$/.test(retryAfter)
                      ? Number(retryAfter) * 1_000
                      : Math.max(0, Date.parse(retryAfter) - now())
            await discard(response)
            throw error
        }
        return response
    }
    async function discard(response) {
        try {
            await response.body?.cancel()
        } catch {
            throw new ReadUnavailable("Cloudflare preview response cleanup failed")
        }
    }
    async function api(path = "", timeout = 30_000) {
        const response = await get(base + path, true, timeout)
        if (!response.ok) {
            await discard(response)
            throw new Error(`Cloudflare readback failed with HTTP ${response.status}`)
        }
        let data
        try {
            data = await response.json()
        } catch {
            throw new ReadUnavailable("Cloudflare readback returned invalid JSON")
        }
        if (data?.success !== true || !data.result) throw new Error("Cloudflare rejected the readback")
        return data.result
    }
    const project = await api()
    if (project.name !== settings.project || typeof project.id !== "string" || !project.id)
        throw new Error("Cloudflare project identity was not verified")
    if (typeof project.production_branch !== "string" || !project.production_branch)
        throw new Error("Cloudflare Production branch was not verified")
    if (project.production_branch === settings.branch)
        throw new Error("Docs preview branch is configured as Production")
    if (project.source != null) {
        if (project.source.config?.production_deployments_enabled !== false)
            throw new Error("Disable Git-connected production deployments before temporary docs delivery")
        if (project.source.config.production_branch !== project.production_branch)
            throw new Error("Git-connected and Pages Production branches disagree")
    }
    if (!Array.isArray(project.domains) || !project.domains.includes(new URL(settings.origin).hostname))
        throw new Error("The public preview hostname is not associated with the selected Pages project")

    // Never rerun Wrangler after an uncertain acknowledgement
    // Wrangler itself may retry Cloudflare UNKNOWN_ERROR during deployment creation
    // Pages has no conditional upload guard against concurrent project-setting changes
    const id = await publish(settings, source)
    if (!deploymentId.test(id ?? ""))
        throw new Error("Upload identity is unknown; reconcile Cloudflare before another upload")
    const deadline = now() + 120_000
    for (let attempt = 0; attempt < 24 && now() < deadline; attempt++) {
        let delay = 5_000
        const timeout = () => Math.max(1, Math.min(10_000, Math.ceil(deadline - now())))
        try {
            const deployment = await api(`/deployments/${id}`, timeout())
            const metadata = deployment.deployment_trigger?.metadata
            if (
                deployment.id !== id ||
                deployment.project_id !== project.id ||
                deployment.project_name !== settings.project ||
                deployment.environment !== "preview" ||
                deployment.production_branch !== project.production_branch ||
                metadata?.branch !== settings.branch ||
                metadata?.commit_hash !== source ||
                metadata?.commit_dirty !== false
            )
                throw new Error("Uploaded deployment identity does not match the checked Preview target")
            if (["failure", "canceled"].includes(deployment.latest_stage?.status))
                throw new Error(
                    "Cloudflare Preview deployment failed or was canceled; inspect it before another upload",
                )
            if (deployment.latest_stage?.name === "deploy" && deployment.latest_stage.status === "success") {
                const route = await get(`${settings.origin}/docs/dev/`, false, timeout())
                await discard(route)
                if ([401, 403].includes(route.status))
                    throw new Error("The configured preview route is not publicly accessible")
                if (route.ok && noindex(route.headers.get("x-robots-tag"))) {
                    const response = await get(`${settings.origin}/deployment.json`, false, timeout())
                    if (!response.ok) await discard(response)
                    if ([401, 403].includes(response.status))
                        throw new Error("The configured preview marker is not publicly accessible")
                    let served
                    try {
                        served = response.ok ? await response.json() : null
                    } catch {
                        served = null
                    }
                    if (served?.sourceCommit === source && now() < deadline)
                        return { origin: settings.origin, deploymentId: id, sourceCommit: source }
                }
            }
        } catch (error) {
            if (!(error instanceof ReadUnavailable)) throw error
            if (Number.isFinite(error.retryAfter)) delay = Math.max(delay, error.retryAfter)
        }
        if (attempt < 23 && now() < deadline) await sleep(Math.min(delay, deadline - now()))
    }
    throw new Error(
        `Preview readback did not converge for deployment ${id}; reconcile its status and custom-domain routing before another upload`,
    )
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = await deployPreview()
        console.log(`Verified Preview deployment at ${result.origin}`)
    } catch (error) {
        console.error(
            error instanceof ReadUnavailable
                ? "Cloudflare preflight is unavailable; no upload was started"
                : error.message,
        )
        process.exitCode = 1
    }
}
