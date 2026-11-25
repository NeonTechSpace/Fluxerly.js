// Builds the static, content-hashed TypeScript 6.0 Language Service Web Worker and 2-tier virtual .d.ts bundles
// (Tier 1: ES2022 + sandbox globals + @neontechspace/fluxerly default/testing + neverthrow;
//  Tier 2: on-demand @neontechspace/fluxerly/effect + 8 Effect modules supported by the offline playground sandbox)
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import ts from "typescript"

const webRoot = fileURLToPath(new URL("../", import.meta.url))
const sdkRoot = resolve(webRoot, "../sdk")
const workerEntry = join(webRoot, "src/playground-ts/worker.ts")
const requireFromWeb = createRequire(import.meta.url)

// Minimal ambient declarations matching the exact browser Web Worker globals exposed by src/playground-runtime/entry.ts.
// Avoids bundling 2 MB of lib.dom.d.ts (window, document, HTMLElement) that cannot run inside the sandbox worker
const sandboxGlobalsDts = `interface Console {
    log(...data: unknown[]): void;
    info(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
    debug(...data: unknown[]): void;
    dir(item?: unknown): void;
}
declare var console: Console;

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearTimeout(id?: number): void;
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearInterval(id?: number): void;
declare function queueMicrotask(callback: () => void): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function structuredClone<T>(value: T): T;

interface AbortSignal {
    readonly aborted: boolean;
    readonly reason: unknown;
    throwIfAborted(): void;
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: "abort", listener: () => void): void;
}
declare var AbortSignal: {
    readonly prototype: AbortSignal;
    abort(reason?: unknown): AbortSignal;
    timeout(milliseconds: number): AbortSignal;
    any(signals: Iterable<AbortSignal>): AbortSignal;
};
interface AbortController {
    readonly signal: AbortSignal;
    abort(reason?: unknown): void;
}
declare var AbortController: {
    readonly prototype: AbortController;
    new (): AbortController;
};

interface URLSearchParams extends Iterable<[string, string]> {
    readonly size: number;
    append(name: string, value: string): void;
    delete(name: string, value?: string): void;
    get(name: string): string | null;
    getAll(name: string): string[];
    has(name: string, value?: string): boolean;
    set(name: string, value: string): void;
    sort(): void;
    toString(): string;
    forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
}
declare var URLSearchParams: {
    readonly prototype: URLSearchParams;
    new (init?: string | string[][] | Record<string, string> | URLSearchParams): URLSearchParams;
};
interface URL {
    hash: string;
    host: string;
    hostname: string;
    href: string;
    readonly origin: string;
    password: string;
    pathname: string;
    port: string;
    protocol: string;
    search: string;
    readonly searchParams: URLSearchParams;
    username: string;
    toJSON(): string;
    toString(): string;
}
declare var URL: {
    readonly prototype: URL;
    new (url: string | URL, base?: string | URL): URL;
    canParse(url: string | URL, base?: string | URL): boolean;
};

interface TextEncoder {
    readonly encoding: string;
    encode(input?: string): Uint8Array<ArrayBuffer>;
}
declare var TextEncoder: { readonly prototype: TextEncoder; new (): TextEncoder };
interface TextDecoder {
    readonly encoding: string;
    decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}
declare var TextDecoder: { readonly prototype: TextDecoder; new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder };

type BlobPart = BufferSource | Blob | string;
interface Blob {
    readonly size: number;
    readonly type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    slice(start?: number, end?: number, contentType?: string): Blob;
    text(): Promise<string>;
}
declare var Blob: {
    readonly prototype: Blob;
    new (blobParts?: BlobPart[], options?: { type?: string }): Blob;
};
interface File extends Blob {
    readonly lastModified: number;
    readonly name: string;
}
declare var File: {
    readonly prototype: File;
    new (fileBits: BlobPart[], fileName: string, options?: { type?: string; lastModified?: number }): File;
};

interface Headers extends Iterable<[string, string]> {
    append(name: string, value: string): void;
    delete(name: string): void;
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    forEach(callbackfn: (value: string, key: string, parent: Headers) => void): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
}
declare var Headers: {
    readonly prototype: Headers;
    new (init?: [string, string][] | Record<string, string> | Headers): Headers;
};
interface FormData extends Iterable<[string, string | File]> {
    append(name: string, value: string | Blob, fileName?: string): void;
    delete(name: string): void;
    get(name: string): string | File | null;
    getAll(name: string): (string | File)[];
    has(name: string): boolean;
    set(name: string, value: string | Blob, fileName?: string): void;
    entries(): IterableIterator<[string, string | File]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string | File>;
}
declare var FormData: { readonly prototype: FormData; new (): FormData };
interface Response {
    readonly headers: Headers;
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    blob(): Promise<Blob>;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
declare var Response: {
    readonly prototype: Response;
    new (body?: BlobPart | FormData | URLSearchParams | null, init?: { status?: number; statusText?: string; headers?: Headers | Record<string, string> }): Response;
};
interface Request {
    readonly headers: Headers;
    readonly method: string;
    readonly url: string;
}
declare var Request: {
    readonly prototype: Request;
    new (input: string | URL | Request, init?: { method?: string; headers?: Headers | Record<string, string>; body?: BlobPart | FormData | URLSearchParams | null; signal?: AbortSignal | null }): Request;
};
declare function fetch(
    input: string | URL | Request,
    init?: { method?: string; headers?: Headers | Record<string, string>; body?: BlobPart | FormData | URLSearchParams | null; signal?: AbortSignal | null },
): Promise<Response>;

interface Performance {
    now(): number;
}
declare var performance: Performance;
interface Crypto {
    randomUUID(): string;
    getRandomValues<T extends ArrayBufferView>(array: T): T;
}
declare var crypto: Crypto;
interface ImportMeta {
    readonly url: string;
    readonly main?: boolean;
}
`

// Matches the exact 8 Effect namespaces exposed by src/playground-runtime/entry.ts so autocomplete and diagnostics stay accurate
const syntheticEffectIndexDts = [
    'export * as Cause from "./Cause.js";',
    'export * as Context from "./Context.js";',
    'export * as Duration from "./Duration.js";',
    'export * as Effect from "./Effect.js";',
    'export * as Exit from "./Exit.js";',
    'export * as Layer from "./Layer.js";',
    'export * as Schedule from "./Schedule.js";',
    'export * as Scope from "./Scope.js";',
].join("\n")

const fluxerlyVirtualPackageJson = JSON.stringify({
    name: "@neontechspace/fluxerly",
    type: "module",
    imports: {
        "#sdk/*": {
            types: "./dist/*.d.ts",
            default: "./dist/*.js",
        },
    },
    exports: {
        ".": { types: "./dist/index.d.ts" },
        "./testing": { types: "./dist/testing.d.ts" },
        "./effect": { types: "./dist/effect.d.ts" },
        "./effect/testing": { types: "./dist/effect-testing.d.ts" },
    },
})

const neverthrowVirtualPackageJson = JSON.stringify({
    name: "neverthrow",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
        ".": { types: "./dist/index.d.ts" },
    },
})

const effectVirtualPackageJson = JSON.stringify({
    name: "effect",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
        ".": { types: "./dist/index.d.ts" },
        "./Cause": { types: "./dist/Cause.d.ts" },
        "./Context": { types: "./dist/Context.d.ts" },
        "./Duration": { types: "./dist/Duration.d.ts" },
        "./Effect": { types: "./dist/Effect.d.ts" },
        "./Exit": { types: "./dist/Exit.d.ts" },
        "./Layer": { types: "./dist/Layer.d.ts" },
        "./Schedule": { types: "./dist/Schedule.d.ts" },
        "./Scope": { types: "./dist/Scope.d.ts" },
    },
})

function shortHash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 10)
}

function cleanDtsText(text, virtualPath) {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n?\/\/# sourceMappingURL=[^\n]*$/m, "")
    // Keep 100% of @neontechspace/fluxerly JSDoc comments intact so hover docs stay rich.
    // For third-party ts-lib and Effect declarations, use TypeScript's own lexer (syntax-safe, never touches strings)
    // to strip verbose @example essays and license banners, cutting wire payload and worker parse time sharply
    if (virtualPath.startsWith("/node_modules/@neontechspace/fluxerly/")) return normalized

    const isEffect = virtualPath.startsWith("/node_modules/effect/")
    const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, normalized)
    let out = ""
    let lastPos = 0
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        const token = scanner.getToken()
        if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
            const start = scanner.getTokenStart()
            const end = scanner.getTokenEnd()
            const comment = normalized.slice(start, end)
            // Preserve triple-slash /// <reference ... /> directives required by lib.es*.d.ts
            if (comment.startsWith("///")) continue
            out += normalized.slice(lastPos, start)
            lastPos = end
        } else if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
            const start = scanner.getTokenStart()
            const end = scanner.getTokenEnd()
            const comment = normalized.slice(start, end)
            out += normalized.slice(lastPos, start)
            if (isEffect && comment.startsWith("/**")) {
                // Keep only the first concise summary sentence before any @example/@since/@category tags
                const summary = compactEffectJsDoc(comment)
                if (summary) out += summary
            }
            lastPos = end
        }
    }
    out += normalized.slice(lastPos)
    return out.replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

function compactEffectJsDoc(comment) {
    const body = comment.slice(3, -2)
    const lines = body
        .split("\n")
        .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    const kept = []
    for (const line of lines) {
        if (/^@(?:example|since|category|internal|tsplus|license|copyright)\b/i.test(line)) break
        if (line.startsWith("```")) break
        if (line.trim() === "" && kept.length > 0) break
        if (line.trim() !== "") kept.push(line.trim())
        if (kept.length >= 2) break
    }
    if (kept.length === 0) return ""
    const joined = kept.join(" ").replace(/\*\//g, "* /")
    return `/** ${joined} */`
}

function toPosix(filePath) {
    return filePath.replaceAll("\\", "/")
}

function resolvePackageRoots(targetSdkRoot = sdkRoot) {
    const tsLibDir = dirname(requireFromWeb.resolve("typescript/lib/lib.es2022.d.ts"))
    const effectDistDir = dirname(requireFromWeb.resolve("effect/Effect"))
    const sdkDistDir = join(targetSdkRoot, "dist")
    const neverthrowPkgPath = requireFromWeb.resolve("neverthrow/package.json", { paths: [targetSdkRoot, sdkRoot, webRoot] })
    const neverthrowDistDir = join(dirname(neverthrowPkgPath), "dist")
    return { tsLibDir, effectDistDir, sdkDistDir, neverthrowDistDir }
}

function mapDiskPathToVirtualPath(filePath, roots) {
    const resolved = resolve(filePath)
    const checks = [
        [roots.tsLibDir, "/lib"],
        [roots.sdkDistDir, "/node_modules/@neontechspace/fluxerly/dist"],
        [roots.neverthrowDistDir, "/node_modules/neverthrow/dist"],
        [roots.effectDistDir, "/node_modules/effect/dist"],
    ]
    for (const [diskRoot, virtualRoot] of checks) {
        const rel = relative(diskRoot, resolved)
        if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
            return `${virtualRoot}/${toPosix(rel)}`
        }
    }
    return null
}

function collectTransitiveDts(probeCode, roots) {
    const options = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["lib.es2022.d.ts"],
        paths: {
            "@neontechspace/fluxerly": [join(roots.sdkDistDir, "index.d.ts")],
            "@neontechspace/fluxerly/testing": [join(roots.sdkDistDir, "testing.d.ts")],
            "@neontechspace/fluxerly/effect": [join(roots.sdkDistDir, "effect.d.ts")],
            "@neontechspace/fluxerly/effect/testing": [join(roots.sdkDistDir, "effect-testing.d.ts")],
        },
    }

    const virtualProbe = resolve(webRoot, ".__playground_ts_probe__.ts")
    const effectIndexPath = resolve(roots.effectDistDir, "index.d.ts")
    const host = ts.createCompilerHost(options)
    const origGetSourceFile = host.getSourceFile.bind(host)
    const origFileExists = host.fileExists.bind(host)

    host.getSourceFile = (fileName, languageVersion, ...rest) => {
        const resolved = resolve(fileName)
        if (resolved === virtualProbe) return ts.createSourceFile(fileName, probeCode, languageVersion)
        if (resolved === effectIndexPath) return ts.createSourceFile(fileName, syntheticEffectIndexDts, languageVersion)
        return origGetSourceFile(fileName, languageVersion, ...rest)
    }
    host.fileExists = (fileName) => {
        const resolved = resolve(fileName)
        return resolved === virtualProbe || resolved === effectIndexPath || origFileExists(fileName)
    }

    const program = ts.createProgram([virtualProbe], options, host)
    /** @type {Record<string, string>} */
    const collected = {}
    for (const sourceFile of program.getSourceFiles()) {
        if (resolve(sourceFile.fileName) === virtualProbe) continue
        const virtualPath = mapDiskPathToVirtualPath(sourceFile.fileName, roots)
        if (!virtualPath) continue
        collected[virtualPath] = cleanDtsText(sourceFile.text, virtualPath)
    }
    return collected
}

export async function buildPlaygroundTypeBundles({ sdkRoot: targetSdkRoot = sdkRoot } = {}) {
    const roots = resolvePackageRoots(targetSdkRoot)

    // Ensure the built SDK declarations exist before tracing
    await readFile(join(roots.sdkDistDir, "index.d.ts"), "utf8")

    const coreFiles = collectTransitiveDts(
        `
        import * as fluxerly from "@neontechspace/fluxerly"
        import * as testing from "@neontechspace/fluxerly/testing"
        export { fluxerly, testing }
        `,
        roots,
    )
    coreFiles["/lib/sandbox-globals.d.ts"] = sandboxGlobalsDts
    coreFiles["/node_modules/@neontechspace/fluxerly/package.json"] = fluxerlyVirtualPackageJson
    coreFiles["/node_modules/neverthrow/package.json"] = neverthrowVirtualPackageJson

    const fullFiles = collectTransitiveDts(
        `
        import * as fluxerly from "@neontechspace/fluxerly"
        import * as testing from "@neontechspace/fluxerly/testing"
        import * as effectSdk from "@neontechspace/fluxerly/effect"
        import * as effectTesting from "@neontechspace/fluxerly/effect/testing"
        import { Cause, Context, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
        export { fluxerly, testing, effectSdk, effectTesting, Cause, Context, Duration, Effect, Exit, Layer, Schedule, Scope }
        `,
        roots,
    )

    /** @type {Record<string, string>} */
    const effectDelta = {
        "/node_modules/effect/package.json": effectVirtualPackageJson,
        "/node_modules/effect/dist/index.d.ts": syntheticEffectIndexDts,
    }
    for (const [virtualPath, text] of Object.entries(fullFiles)) {
        if (!(virtualPath in coreFiles)) {
            effectDelta[virtualPath] = text
        }
    }

    const sortObject = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
    const coreJson = JSON.stringify({ files: sortObject(coreFiles) })
    const effectJson = JSON.stringify({ files: sortObject(effectDelta) })

    return {
        coreJson,
        effectJson,
        coreCount: Object.keys(coreFiles).length,
        effectCount: Object.keys(effectDelta).length,
    }
}

export async function bundlePlaygroundTsWorker({ minify = true } = {}) {
    const result = await build({
        entryPoints: [workerEntry],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        minify,
        sourcemap: false,
        nodePaths: [join(webRoot, "node_modules")],
        define: {
            "process.env.NODE_ENV": '"production"',
        },
        logLevel: "silent",
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error("Playground TypeScript worker build produced no JavaScript output")
    return output.text
}

export async function buildPlaygroundTsAssets({ minify = true, stableSdkRoot = sdkRoot, nightlySdkRoot = "" } = {}) {
    const [workerCode, stableTypes, stablePkgRaw, nightlyBundle] = await Promise.all([
        bundlePlaygroundTsWorker({ minify }),
        buildPlaygroundTypeBundles({ sdkRoot: stableSdkRoot }),
        readFile(join(stableSdkRoot, "package.json"), "utf8"),
        nightlySdkRoot
            ? Promise.all([
                  buildPlaygroundTypeBundles({ sdkRoot: nightlySdkRoot }),
                  readFile(join(nightlySdkRoot, "package.json"), "utf8"),
              ])
            : null,
    ])
    const stableVersion = JSON.parse(stablePkgRaw).version ?? "0.0.0"
    const workerFile = `ts-${shortHash(workerCode)}.js`
    const coreFile = `types-core-${shortHash(stableTypes.coreJson)}.json`
    const effectFile = `types-effect-${shortHash(stableTypes.effectJson)}.json`

    let nightlyAssets = null
    if (nightlyBundle) {
        const [nightlyTypes, nightlyPkgRaw] = nightlyBundle
        const nightlyVersion = JSON.parse(nightlyPkgRaw).version ?? ""
        const nightlyCoreFile = `types-nightly-core-${shortHash(nightlyTypes.coreJson)}.json`
        const nightlyEffectFile = `types-nightly-effect-${shortHash(nightlyTypes.effectJson)}.json`
        nightlyAssets = {
            version: nightlyVersion,
            coreFile: nightlyCoreFile,
            coreJson: nightlyTypes.coreJson,
            effectFile: nightlyEffectFile,
            effectJson: nightlyTypes.effectJson,
            manifest: {
                version: nightlyVersion,
                runtimeUrl: "/playground/runtime-nightly.js",
                coreTypesUrl: `/playground/${nightlyCoreFile}`,
                effectTypesUrl: `/playground/${nightlyEffectFile}`,
            },
        }
    }

    const manifest = {
        stableVersion,
        workerUrl: `/playground/${workerFile}`,
        coreTypesUrl: `/playground/${coreFile}`,
        effectTypesUrl: `/playground/${effectFile}`,
        nightly: nightlyAssets ? nightlyAssets.manifest : null,
    }
    return {
        manifest,
        manifestJson: JSON.stringify(manifest),
        workerFile,
        workerCode,
        coreFile,
        coreJson: stableTypes.coreJson,
        effectFile,
        effectJson: stableTypes.effectJson,
        nightly: nightlyAssets,
    }
}
