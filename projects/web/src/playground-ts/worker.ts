// Dedicated static browser Web Worker running TypeScript 6.0's Language Service against pre-packed .d.ts VFS bundles.
// Zero external dependencies, O(1) virtual filesystem lookups, cached ScriptSnapshots, shared DocumentRegistry and
// on-demand loading of Effect's type definitions so non-Effect bots boot and check at maximum speed
import ts from "typescript"
import type {
    MainToTsWorkerMessage,
    TsCompletionDetails,
    TsCompletionItem,
    TsDiagnostic,
    TsDocTag,
    TsQuickInfo,
    TsWorkerToMainMessage,
} from "./protocol"

interface VirtualFile {
    version: number
    text: string
    snapshot: ts.IScriptSnapshot
}

const rootDir = "/playground"
const defaultFileName = `${rootDir}/bot.ts`

const supportedModules: readonly { readonly name: string; readonly detail: string }[] = [
    { name: "@neontechspace/fluxerly", detail: "Fluxerly default Promise/Result SDK" },
    { name: "@neontechspace/fluxerly/testing", detail: "In-memory createTestBot and fixtures" },
    { name: "@neontechspace/fluxerly/effect", detail: "Native Effect 4 Fluxerly SDK" },
    { name: "@neontechspace/fluxerly/effect/testing", detail: "Effect createTestBot and test layer" },
    { name: "effect", detail: "Effect 4 core modules (Effect, Cause, Context, Duration, Exit, Layer, Schedule, Scope)" },
    { name: "effect/Effect", detail: "Effect 4 Effect module" },
    { name: "effect/Cause", detail: "Effect 4 Cause module" },
    { name: "effect/Context", detail: "Effect 4 Context module" },
    { name: "effect/Duration", detail: "Effect 4 Duration module" },
    { name: "effect/Exit", detail: "Effect 4 Exit module" },
    { name: "effect/Layer", detail: "Effect 4 Layer module" },
    { name: "effect/Schedule", detail: "Effect 4 Schedule module" },
    { name: "effect/Scope", detail: "Effect 4 Scope module" },
]

// Use TypeScript's own fast scanner so comments between `from` and `"effect"` work while string literals never trigger Tier 2
function importsEffect(code: string): boolean {
    if (!code.includes("effect")) return false
    const info = ts.preProcessFile(code, true, true)
    return info.importedFiles.some(
        (ref) =>
            ref.fileName === "effect" ||
            ref.fileName.startsWith("effect/") ||
            ref.fileName === "@neontechspace/fluxerly/effect" ||
            ref.fileName === "@neontechspace/fluxerly/effect/testing",
    )
}

const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    isolatedModules: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
    lib: ["lib.es2022.d.ts"],
    types: [],
    noResolve: false,
}

const files = new Map<string, VirtualFile>()
const directories = new Map<string, Set<string>>()
const directoryFiles = new Map<string, Set<string>>()

let activeFileName = defaultFileName
let projectVersion = 1
let effectTypesUrl = ""
let effectLoaded = false
let effectLoadingPromise: Promise<void> | undefined
let languageService: ts.LanguageService | undefined
let moduleResolutionCache: ts.ModuleResolutionCache | undefined
const documentRegistry = ts.createDocumentRegistry(true, "/")

function post(message: TsWorkerToMainMessage): void {
    ;(globalThis as unknown as { postMessage(payload: TsWorkerToMainMessage): void }).postMessage(message)
}

function normalizePath(filePath: string): string {
    const posix = filePath.replaceAll("\\", "/")
    if (posix.startsWith("/")) return posix
    return `/${posix}`
}

function toPlaygroundFile(name: string): string {
    const clean = name.replaceAll("\\", "/").replace(/^\/+/, "")
    if (clean.startsWith("playground/")) return `/${clean}`
    const base = clean.split("/").pop() || "bot.ts"
    return `${rootDir}/${base}`
}

function indexPath(filePath: string): void {
    const slash = filePath.lastIndexOf("/")
    const dir = slash <= 0 ? "/" : filePath.slice(0, slash)
    const name = filePath.slice(slash + 1)
    let fileBucket = directoryFiles.get(dir)
    if (!fileBucket) {
        fileBucket = new Set<string>()
        directoryFiles.set(dir, fileBucket)
    }
    fileBucket.add(name)

    // Register every ancestor directory in O(depth) so directoryExists and getDirectories run in O(1)
    let current = dir
    while (true) {
        if (!directories.has(current)) directories.set(current, new Set<string>())
        if (current === "/") break
        const parentSlash = current.lastIndexOf("/")
        const parent = parentSlash <= 0 ? "/" : current.slice(0, parentSlash)
        const childName = current.slice(parentSlash + 1)
        let children = directories.get(parent)
        if (!children) {
            children = new Set<string>()
            directories.set(parent, children)
        }
        children.add(childName)
        current = parent
    }
}

function setVirtualFile(filePath: string, text: string, version?: number): boolean {
    const normalized = normalizePath(filePath)
    const existing = files.get(normalized)
    if (existing && existing.text === text) return false
    const nextVersion = version ?? (existing ? existing.version + 1 : 1)
    files.set(normalized, {
        version: nextVersion,
        text,
        snapshot: ts.ScriptSnapshot.fromString(text),
    })
    if (!existing) indexPath(normalized)
    return true
}

function resetLibraryFiles(): void {
    const kept = new Map<string, VirtualFile>()
    for (const [path, entry] of files) {
        if (path.startsWith(`${rootDir}/`)) kept.set(path, entry)
    }
    files.clear()
    directories.clear()
    directoryFiles.clear()
    for (const [path, entry] of kept) {
        files.set(path, entry)
        indexPath(path)
    }
    effectLoaded = false
    effectLoadingPromise = undefined
}

function loadFilesMap(record: Record<string, string>): number {
    let added = 0
    for (const [rawPath, text] of Object.entries(record)) {
        const normalized = normalizePath(rawPath)
        if (!files.has(normalized)) added += 1
        setVirtualFile(normalized, text, 1)
    }
    return added
}

function resetModuleResolutionCache(): void {
    moduleResolutionCache = ts.createModuleResolutionCache("/", (fileName) => fileName, compilerOptions)
}

function createService(): ts.LanguageService {
    resetModuleResolutionCache()
    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getProjectVersion: () => String(projectVersion),
        getScriptFileNames: () => [activeFileName, "/lib/sandbox-globals.d.ts"],
        getScriptVersion: (fileName) => {
            const entry = files.get(normalizePath(fileName))
            return entry ? String(entry.version) : "0"
        },
        getScriptSnapshot: (fileName) => files.get(normalizePath(fileName))?.snapshot,
        getCurrentDirectory: () => rootDir,
        getDefaultLibFileName: () => "/lib/lib.es2022.d.ts",
        fileExists: (fileName) => files.has(normalizePath(fileName)),
        readFile: (fileName) => files.get(normalizePath(fileName))?.text,
        directoryExists: (dirPath) => {
            const normalized = normalizePath(dirPath).replace(/\/+$/, "") || "/"
            return directories.has(normalized)
        },
        getDirectories: (dirPath) => {
            const normalized = normalizePath(dirPath).replace(/\/+$/, "") || "/"
            const children = directories.get(normalized)
            return children ? [...children] : []
        },
        readDirectory: (dirPath, extensions) => {
            const normalized = normalizePath(dirPath).replace(/\/+$/, "") || "/"
            const names = directoryFiles.get(normalized)
            if (!names) return []
            const prefix = normalized === "/" ? "" : normalized
            const results: string[] = []
            for (const name of names) {
                if (!extensions || extensions.some((ext) => name.endsWith(ext))) {
                    results.push(`${prefix}/${name}`)
                }
            }
            return results
        },
        realpath: (path) => normalizePath(path),
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        resolveModuleNameLiterals: (moduleLiterals, containingFile, _redirected, options) =>
            moduleLiterals.map((literal) =>
                ts.resolveModuleName(literal.text, normalizePath(containingFile), options, host, moduleResolutionCache),
            ),
    }
    return ts.createLanguageService(host, documentRegistry)
}

function parseTypesBuffer(buffer: ArrayBuffer): Record<string, string> {
    const text = new TextDecoder().decode(buffer)
    const payload = JSON.parse(text) as { files?: Record<string, string> }
    if (!payload || typeof payload.files !== "object" || payload.files === null) {
        throw new Error("Invalid transferred type bundle payload")
    }
    return payload.files
}

async function fetchTypesJson(url: string): Promise<Record<string, string>> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch type bundle ${url} (HTTP ${response.status})`)
    const payload = (await response.json()) as { files?: Record<string, string> }
    if (!payload || typeof payload.files !== "object" || payload.files === null) {
        throw new Error(`Invalid type bundle payload from ${url}`)
    }
    return payload.files
}

async function ensureEffectTypesLoaded(code: string): Promise<boolean> {
    if (effectLoaded || !effectTypesUrl || !importsEffect(code)) return false
    if (!effectLoadingPromise) {
        const start = performance.now()
        effectLoadingPromise = fetchTypesJson(effectTypesUrl)
            .then((effectFiles) => {
                const count = loadFilesMap(effectFiles)
                effectLoaded = true
                resetModuleResolutionCache()
                projectVersion += 1
                post({
                    type: "effectLoaded",
                    loadMs: Math.round(performance.now() - start),
                    fileCount: count,
                })
            })
            .catch((error: unknown) => {
                effectLoadingPromise = undefined
                throw error
            })
    }
    await effectLoadingPromise
    return true
}

const kindMap = new Map<ts.ScriptElementKind, string>([
    [ts.ScriptElementKind.functionElement, "function"],
    [ts.ScriptElementKind.localFunctionElement, "function"],
    [ts.ScriptElementKind.memberFunctionElement, "method"],
    [ts.ScriptElementKind.constructSignatureElement, "method"],
    [ts.ScriptElementKind.callSignatureElement, "method"],
    [ts.ScriptElementKind.memberVariableElement, "property"],
    [ts.ScriptElementKind.memberGetAccessorElement, "property"],
    [ts.ScriptElementKind.memberSetAccessorElement, "property"],
    [ts.ScriptElementKind.classElement, "class"],
    [ts.ScriptElementKind.localClassElement, "class"],
    [ts.ScriptElementKind.interfaceElement, "interface"],
    [ts.ScriptElementKind.enumElement, "enum"],
    [ts.ScriptElementKind.enumMemberElement, "enum"],
    [ts.ScriptElementKind.constElement, "constant"],
    [ts.ScriptElementKind.variableElement, "variable"],
    [ts.ScriptElementKind.letElement, "variable"],
    [ts.ScriptElementKind.localVariableElement, "variable"],
    [ts.ScriptElementKind.parameterElement, "variable"],
    [ts.ScriptElementKind.keyword, "keyword"],
    [ts.ScriptElementKind.typeElement, "type"],
    [ts.ScriptElementKind.typeParameterElement, "type"],
    [ts.ScriptElementKind.primitiveType, "type"],
    [ts.ScriptElementKind.moduleElement, "namespace"],
    [ts.ScriptElementKind.externalModuleName, "namespace"],
])

function mapKind(kind: ts.ScriptElementKind): string {
    return kindMap.get(kind) ?? "text"
}

function formatTags(tags: readonly ts.JSDocTagInfo[] | undefined): readonly TsDocTag[] {
    if (!tags || tags.length === 0) return []
    const result: TsDocTag[] = []
    for (const tag of tags) {
        if (tag.name === "since" || tag.name === "category" || tag.name === "internal") continue
        const text = ts.displayPartsToString(tag.text).trim()
        if (!text && tag.name !== "deprecated") continue
        result.push({ name: tag.name, text })
        if (result.length >= 6) break
    }
    return result
}

function formatDiagnosticMessage(messageText: string | ts.DiagnosticMessageChain): string {
    return ts.flattenDiagnosticMessageText(messageText, "\n")
}

function findImportSpecifierRange(text: string, offset: number): { from: number; to: number; typed: string } | null {
    const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
    const before = text.slice(lineStart, offset)
    const match = /(?:from|import)\s*\(?\s*(["'])([^"']*)$/.exec(before)
    if (!match) return null
    const quote = match[1]!
    const typed = match[2]!
    const from = offset - typed.length
    const lineEndIdx = text.indexOf("\n", offset)
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
    const closeIdx = text.indexOf(quote, offset)
    const to = closeIdx !== -1 && closeIdx <= lineEnd ? closeIdx : offset
    return { from, to, typed }
}

function computeIdentifierRange(text: string, offset: number): { from: number; to: number; prefix: string } {
    let from = offset
    while (from > 0 && /[A-Za-z0-9_$]/.test(text[from - 1]!)) from -= 1
    return { from, to: offset, prefix: text.slice(from, offset) }
}

function handleComplete(
    id: number,
    rawFileName: string,
    offset: number,
    triggerCharacter: string | undefined,
    _explicit: boolean,
): void {
    const service = languageService
    if (!service) {
        post({ type: "completeResult", id, from: offset, to: offset, items: [] })
        return
    }
    const fileName = toPlaygroundFile(rawFileName)
    const entry = files.get(fileName)
    if (!entry) {
        post({ type: "completeResult", id, from: offset, to: offset, items: [] })
        return
    }

    // Dedicated module specifier completions so only real sandbox-supported imports appear
    const importSpec = findImportSpecifierRange(entry.text, offset)
    if (importSpec) {
        const lower = importSpec.typed.toLowerCase()
        const items: TsCompletionItem[] = supportedModules
            .filter((mod) => !lower || mod.name.toLowerCase().includes(lower))
            .map((mod, idx) => ({
                label: mod.name,
                kind: "namespace",
                sortText: String(idx).padStart(3, "0"),
                detail: mod.detail,
            }))
        post({ type: "completeResult", id, from: importSpec.from, to: importSpec.to, items })
        return
    }

    const triggerKind = triggerCharacter ? ts.CompletionTriggerKind.TriggerCharacter : ts.CompletionTriggerKind.Invoked

    const info = service.getCompletionsAtPosition(fileName, offset, {
        triggerCharacter: triggerCharacter as ts.CompletionsTriggerCharacter | undefined,
        triggerKind,
        includeCompletionsForModuleExports: false,
        includeCompletionsWithInsertText: true,
        includeAutomaticOptionalChainCompletions: true,
    })

    const word = computeIdentifierRange(entry.text, offset)
    if (!info || info.entries.length === 0) {
        post({ type: "completeResult", id, from: word.from, to: word.to, items: [], isIncomplete: false })
        return
    }

    const lowerPrefix = word.prefix.toLowerCase()
    const filtered: ts.CompletionEntry[] = []
    for (const item of info.entries) {
        if (item.name.startsWith("__") && !word.prefix.startsWith("__")) continue
        if (item.kind === ts.ScriptElementKind.warning) continue
        if (lowerPrefix) {
            const lowerName = item.name.toLowerCase()
            if (!lowerName.includes(lowerPrefix)) continue
        }
        filtered.push(item)
    }

    // Prioritize exact prefix matches and TypeScript's own sortText with fast ASCII ordering
    filtered.sort((a, b) => {
        if (lowerPrefix) {
            const aStarts = a.name.toLowerCase().startsWith(lowerPrefix) ? 0 : 1
            const bStarts = b.name.toLowerCase().startsWith(lowerPrefix) ? 0 : 1
            if (aStarts !== bStarts) return aStarts - bStarts
        }
        if (a.sortText !== b.sortText) return a.sortText < b.sortText ? -1 : 1
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })

    const maxEntries = info.isMemberCompletion ? 120 : 80
    const slice = filtered.slice(0, maxEntries)
    const span = info.optionalReplacementSpan
    const from = span ? span.start : word.from
    const to = span ? span.start + span.length : word.to

    const items: TsCompletionItem[] = slice.map((item) => ({
        label: item.name,
        kind: mapKind(item.kind),
        sortText: item.sortText,
        ...(item.insertText && item.insertText !== item.name ? { insertText: item.insertText } : {}),
        ...(item.replacementSpan
            ? {
                  replaceFrom: item.replacementSpan.start,
                  replaceTo: item.replacementSpan.start + item.replacementSpan.length,
              }
            : {}),
        ...(item.source ? { source: item.source } : {}),
        ...(item.isRecommended ? { isRecommended: true } : {}),
    }))

    post({ type: "completeResult", id, from, to, items, isIncomplete: filtered.length > maxEntries })
}

function handleCompletionDetails(id: number, rawFileName: string, offset: number, name: string, source?: string): void {
    const service = languageService
    const fileName = toPlaygroundFile(rawFileName)
    if (!service || !files.has(fileName)) {
        post({ type: "completionDetailsResult", id, details: null })
        return
    }
    const details = service.getCompletionEntryDetails(fileName, offset, name, undefined, source, undefined, undefined)
    if (!details) {
        post({ type: "completionDetailsResult", id, details: null })
        return
    }
    const result: TsCompletionDetails = {
        display: ts.displayPartsToString(details.displayParts),
        documentation: ts.displayPartsToString(details.documentation),
        tags: formatTags(details.tags),
    }
    post({ type: "completionDetailsResult", id, details: result })
}

function handleHover(id: number, rawFileName: string, offset: number): void {
    const service = languageService
    const fileName = toPlaygroundFile(rawFileName)
    if (!service || !files.has(fileName)) {
        post({ type: "hoverResult", id, info: null })
        return
    }
    const quick = service.getQuickInfoAtPosition(fileName, offset)
    if (!quick) {
        post({ type: "hoverResult", id, info: null })
        return
    }
    const info: TsQuickInfo = {
        from: quick.textSpan.start,
        to: quick.textSpan.start + quick.textSpan.length,
        display: ts.displayPartsToString(quick.displayParts),
        documentation: ts.displayPartsToString(quick.documentation),
        tags: formatTags(quick.tags),
    }
    post({ type: "hoverResult", id, info })
}

function collectDiagnostics(service: ts.LanguageService, fileName: string, entry: VirtualFile): TsDiagnostic[] {
    const syntactic = service.getSyntacticDiagnostics(fileName)
    const semantic = service.getSemanticDiagnostics(fileName)
    const all = [...syntactic, ...semantic]
    const maxLen = entry.text.length
    const diagnostics: TsDiagnostic[] = []

    for (const diag of all) {
        if (diag.category !== ts.DiagnosticCategory.Error && diag.category !== ts.DiagnosticCategory.Warning) continue
        const from = Math.max(0, Math.min(diag.start ?? 0, maxLen))
        const length = Math.max(1, diag.length ?? 1)
        const to = Math.max(from, Math.min(from + length, maxLen))
        diagnostics.push({
            from,
            to,
            message: formatDiagnosticMessage(diag.messageText),
            code: diag.code,
            severity: diag.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
        })
        if (diagnostics.length >= 40) break
    }
    return diagnostics
}

function handleDiagnostics(id: number, rawFileName: string, version: number): void {
    const service = languageService
    if (!service) {
        post({ type: "diagnosticsResult", id, fileName: rawFileName, version, diagnostics: [] })
        return
    }
    const fileName = toPlaygroundFile(rawFileName)
    const entry = files.get(fileName)
    if (!entry) {
        post({ type: "diagnosticsResult", id, fileName: rawFileName, version, diagnostics: [] })
        return
    }
    post({ type: "diagnosticsResult", id, fileName: rawFileName, version, diagnostics: collectDiagnostics(service, fileName, entry) })
}

let pendingQueue: Promise<void> = Promise.resolve()
let latestCompleteId = 0
let latestDetailsId = 0
let latestHoverId = 0
let latestDiagnosticsId = 0

async function processMessage(message: MainToTsWorkerMessage): Promise<void> {
    if (message.type === "init") {
        const start = performance.now()
        effectTypesUrl = message.effectTypesUrl
        const coreFiles = message.coreBuffer ? parseTypesBuffer(message.coreBuffer) : await fetchTypesJson(message.coreTypesUrl)
        loadFilesMap(coreFiles)
        activeFileName = toPlaygroundFile(message.fileName)
        const initVersion = message.version ?? 1
        setVirtualFile(activeFileName, message.code, initVersion)
        if (importsEffect(message.code)) {
            await ensureEffectTypesLoaded(message.code)
        }
        languageService = createService()
        // Pre-warm TypeChecker and reuse its diagnostics in the ready payload so boot needs no second pass
        const entry = files.get(activeFileName)
        const diagnostics = entry ? collectDiagnostics(languageService, activeFileName, entry) : []
        post({
            type: "ready",
            bootMs: Math.round(performance.now() - start),
            fileCount: files.size,
            hasEffect: effectLoaded,
            fileName: message.fileName,
            version: initVersion,
            diagnostics,
        })
        return
    }

    if (message.type === "switchChannel") {
        const start = performance.now()
        effectTypesUrl = message.effectTypesUrl
        const coreFiles = message.coreBuffer ? parseTypesBuffer(message.coreBuffer) : await fetchTypesJson(message.coreTypesUrl)
        resetLibraryFiles()
        loadFilesMap(coreFiles)
        activeFileName = toPlaygroundFile(message.fileName)
        setVirtualFile(activeFileName, message.code, message.version)
        if (importsEffect(message.code)) {
            await ensureEffectTypesLoaded(message.code)
        }
        resetModuleResolutionCache()
        projectVersion += 1
        languageService ??= createService()
        const entry = files.get(activeFileName)
        const diagnostics = entry ? collectDiagnostics(languageService, activeFileName, entry) : []
        post({
            type: "ready",
            bootMs: Math.round(performance.now() - start),
            fileCount: files.size,
            hasEffect: effectLoaded,
            fileName: message.fileName,
            version: message.version,
            diagnostics,
        })
        return
    }

    if (message.type === "update") {
        const nextFile = toPlaygroundFile(message.fileName)
        const fileSwitched = nextFile !== activeFileName
        activeFileName = nextFile
        const changed = setVirtualFile(activeFileName, message.code, message.version)
        if (changed || fileSwitched) projectVersion += 1
        if (fileSwitched) resetModuleResolutionCache()
        if (importsEffect(message.code) && !effectLoaded) {
            await ensureEffectTypesLoaded(message.code)
        }
        return
    }

    if (message.type === "complete") {
        if (message.id !== latestCompleteId) return
        const entry = files.get(toPlaygroundFile(message.fileName))
        if (entry && importsEffect(entry.text) && !effectLoaded) {
            await ensureEffectTypesLoaded(entry.text)
        }
        if (message.id !== latestCompleteId) return
        handleComplete(message.id, message.fileName, message.offset, message.triggerCharacter, message.explicit)
        return
    }

    if (message.type === "completionDetails") {
        if (message.id !== latestDetailsId) return
        handleCompletionDetails(message.id, message.fileName, message.offset, message.name, message.source)
        return
    }

    if (message.type === "hover") {
        if (message.id !== latestHoverId) return
        const entry = files.get(toPlaygroundFile(message.fileName))
        if (entry && importsEffect(entry.text) && !effectLoaded) {
            await ensureEffectTypesLoaded(entry.text)
        }
        if (message.id !== latestHoverId) return
        handleHover(message.id, message.fileName, message.offset)
        return
    }

    if (message.type === "diagnostics") {
        if (message.id !== latestDiagnosticsId) return
        const entry = files.get(toPlaygroundFile(message.fileName))
        if (entry && importsEffect(entry.text) && !effectLoaded) {
            await ensureEffectTypesLoaded(entry.text)
        }
        if (message.id !== latestDiagnosticsId) return
        handleDiagnostics(message.id, message.fileName, message.version)
    }
}

globalThis.addEventListener("message", (event: MessageEvent<MainToTsWorkerMessage>) => {
    const data = event.data
    if (!data || typeof data !== "object" || typeof data.type !== "string") return
    // Track newest request IDs synchronously so superseded work drops before touching the TypeScript Language Service
    if (data.type === "complete") latestCompleteId = data.id
    else if (data.type === "completionDetails") latestDetailsId = data.id
    else if (data.type === "hover") latestHoverId = data.id
    else if (data.type === "diagnostics") latestDiagnosticsId = data.id

    pendingQueue = pendingQueue
        .then(() => processMessage(data))
        .catch((error: unknown) => {
            post({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            })
        })
})
