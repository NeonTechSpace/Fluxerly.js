// Bundles the real @neontechspace/fluxerly SDK, createTestBot and Sucrase into one browser-ready runtime script
// for the isolated playground iframe. Zero external CDNs, zero server functions and zero modifications to SDK source
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { buildPlaygroundTsAssets } from "./playground-ts-assets.mjs"

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

function createShimPlugin(targetSdkRoot = sdkRoot) {
    return {
        name: "fluxerly-browser-shims",
        setup(pluginBuild) {
            if (resolve(targetSdkRoot) !== resolve(sdkRoot)) {
                pluginBuild.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/sdk\/dist\/.+\.js$/ }, (args) => {
                    const file = args.path.slice("../../../sdk/dist/".length)
                    return { path: join(targetSdkRoot, "dist", file) }
                })
            }
            pluginBuild.onResolve({ filter: /^(?:node:|events$|crypto$|timers$|util$|fs$|url$|os$|ws$)/ }, (args) => {
                const target = shimMap.get(args.path)
                if (target) return { path: target }
                return undefined
            })
        },
    }
}

export async function bundlePlaygroundRuntime({ minify = true, sdkRoot: targetSdkRoot = sdkRoot } = {}) {
    const manifest = JSON.parse(await readFile(join(targetSdkRoot, "package.json"), "utf8"))
    const result = await build({
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        minify,
        sourcemap: false,
        nodePaths: [join(targetSdkRoot, "node_modules"), join(sdkRoot, "node_modules"), join(webRoot, "node_modules")],
        plugins: [createShimPlugin(targetSdkRoot)],
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
    let cachedDevBundlePromise = null
    let cachedDevNightlyBundlePromise = null
    let cachedDevTsAssetsPromise = null
    const nightlyDir = () => process.env.PLAYGROUND_NIGHTLY_SDK_DIR || ""
    const getDevBundle = () => {
        cachedDevBundlePromise ??= bundlePlaygroundRuntime({ minify: false }).catch((error) => {
            cachedDevBundlePromise = null
            throw error
        })
        return cachedDevBundlePromise
    }
    const getDevNightlyBundle = () => {
        const dir = nightlyDir()
        if (!dir) return Promise.resolve(null)
        cachedDevNightlyBundlePromise ??= bundlePlaygroundRuntime({ minify: false, sdkRoot: dir }).catch((error) => {
            cachedDevNightlyBundlePromise = null
            throw error
        })
        return cachedDevNightlyBundlePromise
    }
    const getDevTsAssets = () => {
        cachedDevTsAssetsPromise ??= buildPlaygroundTsAssets({ minify: false, nightlySdkRoot: nightlyDir() }).catch((error) => {
            cachedDevTsAssetsPromise = null
            throw error
        })
        return cachedDevTsAssetsPromise
    }
    return {
        name: "fluxerly-playground-runtime",
        hooks: {
            "astro:server:setup": ({ server }) => {
                server.watcher.on("change", (changedFile) => {
                    const normalized = changedFile.replaceAll("\\", "/")
                    if (normalized.includes("/playground-runtime/") || normalized.includes("/sdk/dist/")) {
                        cachedDevBundlePromise = null
                        cachedDevNightlyBundlePromise = null
                    }
                    if (
                        normalized.includes("/playground-ts/") ||
                        normalized.includes("/scripts/playground-ts-assets.mjs") ||
                        normalized.includes("/sdk/dist/")
                    ) {
                        cachedDevTsAssetsPromise = null
                    }
                })
                server.middlewares.use(async (req, res, next) => {
                    const pathname = req.url?.split("?")[0]
                    if (!pathname?.startsWith("/playground/")) return next()
                    try {
                        if (pathname === "/playground/runtime.js") {
                            const bundle = await getDevBundle()
                            res.setHeader("content-type", "text/javascript; charset=utf-8")
                            res.setHeader("cache-control", "no-store")
                            res.end(bundle)
                            return
                        }
                        if (pathname === "/playground/runtime-nightly.js") {
                            const bundle = await getDevNightlyBundle()
                            if (!bundle) return next()
                            res.setHeader("content-type", "text/javascript; charset=utf-8")
                            res.setHeader("cache-control", "no-store")
                            res.end(bundle)
                            return
                        }
                        if (
                            pathname === "/playground/ts-manifest.json" ||
                            pathname.startsWith("/playground/ts-") ||
                            pathname.startsWith("/playground/types-")
                        ) {
                            const tsAssets = await getDevTsAssets()
                            if (pathname === "/playground/ts-manifest.json") {
                                res.setHeader("content-type", "application/json; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.manifestJson)
                                return
                            }
                            if (pathname === tsAssets.manifest.workerUrl) {
                                res.setHeader("content-type", "text/javascript; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.workerCode)
                                return
                            }
                            if (pathname === tsAssets.manifest.coreTypesUrl) {
                                res.setHeader("content-type", "application/json; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.coreJson)
                                return
                            }
                            if (pathname === tsAssets.manifest.effectTypesUrl) {
                                res.setHeader("content-type", "application/json; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.effectJson)
                                return
                            }
                            if (tsAssets.nightly && pathname === tsAssets.nightly.manifest.coreTypesUrl) {
                                res.setHeader("content-type", "application/json; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.nightly.coreJson)
                                return
                            }
                            if (tsAssets.nightly && pathname === tsAssets.nightly.manifest.effectTypesUrl) {
                                res.setHeader("content-type", "application/json; charset=utf-8")
                                res.setHeader("cache-control", "no-store")
                                res.end(tsAssets.nightly.effectJson)
                                return
                            }
                        }
                        return next()
                    } catch (error) {
                        next(error)
                    }
                })
            },
            "astro:build:done": async ({ dir }) => {
                // Versioned docs-only builds under /docs/<version>/ do not serve /playground/
                if (process.env.PUBLIC_DOCS_BASE) return
                const outDir = join(fileURLToPath(dir), "playground")
                const nightlySdkRoot = nightlyDir()
                const [code, nightlyCode, tsAssets] = await Promise.all([
                    bundlePlaygroundRuntime({ minify: true }),
                    nightlySdkRoot ? bundlePlaygroundRuntime({ minify: true, sdkRoot: nightlySdkRoot }) : null,
                    buildPlaygroundTsAssets({ minify: true, nightlySdkRoot }),
                ])
                await mkdir(outDir, { recursive: true })
                const writes = [
                    writeFile(join(outDir, "runtime.js"), code, "utf8"),
                    writeFile(join(outDir, "ts-manifest.json"), tsAssets.manifestJson, "utf8"),
                    writeFile(join(outDir, tsAssets.workerFile), tsAssets.workerCode, "utf8"),
                    writeFile(join(outDir, tsAssets.coreFile), tsAssets.coreJson, "utf8"),
                    writeFile(join(outDir, tsAssets.effectFile), tsAssets.effectJson, "utf8"),
                ]
                if (nightlyCode && tsAssets.nightly) {
                    writes.push(
                        writeFile(join(outDir, "runtime-nightly.js"), nightlyCode, "utf8"),
                        writeFile(join(outDir, tsAssets.nightly.coreFile), tsAssets.nightly.coreJson, "utf8"),
                        writeFile(join(outDir, tsAssets.nightly.effectFile), tsAssets.nightly.effectJson, "utf8"),
                    )
                }
                await Promise.all(writes)
            },
        },
    }
}
