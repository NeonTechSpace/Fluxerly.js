// Bundles the real @neontechspace/fluxerly SDK, createTestBot and Sucrase into one browser-ready runtime script
// for the isolated playground iframe. Zero external CDNs, zero server functions and zero modifications to SDK source
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const sdkRoot = resolve(webRoot, "../sdk")
const shimsRoot = join(webRoot, "src/playground-runtime/shims")
const entryFile = join(webRoot, "src/playground-runtime/entry.ts")

const shimMap = new Map([
    ["node:events", join(shimsRoot, "node-events.ts")],
    ["events", join(shimsRoot, "node-events.ts")],
    ["node:crypto", join(shimsRoot, "node-crypto.ts")],
    ["crypto", join(shimsRoot, "node-crypto.ts")],
    ["node:timers", join(shimsRoot, "node-timers.ts")],
    ["timers", join(shimsRoot, "node-timers.ts")],
    ["node:timers/promises", join(shimsRoot, "node-timers-promises.ts")],
    ["node:util", join(shimsRoot, "node-util.ts")],
    ["util", join(shimsRoot, "node-util.ts")],
    ["node:async_hooks", join(shimsRoot, "node-async-hooks.ts")],
    ["node:fs", join(shimsRoot, "node-misc.ts")],
    ["fs", join(shimsRoot, "node-misc.ts")],
    ["node:fs/promises", join(shimsRoot, "node-misc.ts")],
    ["node:path", join(shimsRoot, "node-misc.ts")],
    ["path", join(shimsRoot, "node-misc.ts")],
    ["node:child_process", join(shimsRoot, "node-misc.ts")],
    ["child_process", join(shimsRoot, "node-misc.ts")],
    ["node:url", join(shimsRoot, "node-misc.ts")],
    ["url", join(shimsRoot, "node-misc.ts")],
    ["node:os", join(shimsRoot, "node-misc.ts")],
    ["os", join(shimsRoot, "node-misc.ts")],
    ["ws", join(shimsRoot, "node-misc.ts")],
])

function createShimPlugin() {
    return {
        name: "fluxerly-browser-shims",
        setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^(?:node:|events$|crypto$|timers$|util$|fs$|url$|os$|ws$)/ }, (args) => {
                const target = shimMap.get(args.path)
                if (target) return { path: target }
                return undefined
            })
        },
    }
}

export async function bundlePlaygroundRuntime({ minify = true } = {}) {
    const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"))
    const result = await build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        minify,
        sourcemap: false,
        nodePaths: [join(sdkRoot, "node_modules"), join(webRoot, "node_modules")],
        plugins: [createShimPlugin()],
        define: {
            "import.meta.url": JSON.stringify("file:///fluxerly/dist/internal/logging.js"),
            __FLUXERLY_SDK_VERSION__: JSON.stringify(manifest.version ?? "0.0.0"),
            __FLUXERLY_SDK_HOMEPAGE__: JSON.stringify(manifest.homepage ?? "https://fluxerly.neontechspace.com/"),
        },
        logLevel: "silent",
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error("Playground runtime build produced no JavaScript output")
    return output.text
}

export default function playgroundRuntime() {
    let cachedDevBundle = null
    return {
        name: "fluxerly-playground-runtime",
        hooks: {
            "astro:server:setup": ({ server }) => {
                server.middlewares.use(async (req, res, next) => {
                    if (req.url?.split("?")[0] !== "/playground/runtime.js") return next()
                    try {
                        cachedDevBundle ??= await bundlePlaygroundRuntime({ minify: false })
                        res.setHeader("content-type", "text/javascript; charset=utf-8")
                        res.setHeader("cache-control", "no-store")
                        res.end(cachedDevBundle)
                    } catch (error) {
                        next(error)
                    }
                })
            },
            "astro:build:done": async ({ dir }) => {
                // Versioned docs-only builds under /docs/<version>/ do not serve /playground/
                if (process.env.PUBLIC_DOCS_BASE) return
                const code = await bundlePlaygroundRuntime({ minify: true })
                const outFile = join(fileURLToPath(dir), "playground/runtime.js")
                await mkdir(dirname(outFile), { recursive: true })
                await writeFile(outFile, code, "utf8")
            },
        },
    }
}
