import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { referenceEntries } from "./reference-entries.js"
import { entryPreference, importsOnlyEffect, pageContext, referenceIndexFor } from "./reference-links.js"

// Code block identifiers that name public SDK API are resolved with the TypeScript checker against the SDK
// declarations, so destructured parameters such as reply and member chains such as client.messages.send find their
// declaring symbol. The wrapped tokens keep their text, so the visible code, copy output and line layout do not change

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../sdk")
const languages = new Map([["ts", ".ts"], ["typescript", ".ts"], ["js", ".js"], ["javascript", ".js"]])
const ownerKinds = new Set([ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration])
let service
let warned = false

/** Package specifiers and their reference entry names, read from the SDK's exports and the reference entry list */
function sdkEntries() {
    const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"))
    return Object.entries(manifest.exports ?? {}).flatMap(([key, value]) => {
        const entry = referenceEntries.find((candidate) => value?.types === `./dist/${candidate.declarations}`)
        return entry ? [{ specifier: manifest.name + key.slice(1), file: join(sdkRoot, "dist", entry.declarations), name: entry.name }] : []
    })
}

function createService(entries) {
    // Blocks are analyzed as modules inside the SDK package, so its own package name resolves to its declarations
    const files = new Map()
    const options = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
    }
    const host = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => [...files.keys()],
        getScriptVersion: (name) => String(files.get(name)?.version ?? 0),
        getScriptSnapshot: (name) => {
            const text = files.has(name) ? files.get(name).text : ts.sys.readFile(name)
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => sdkRoot,
        getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
        fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
        readFile: (name) => files.get(name)?.text ?? ts.sys.readFile(name),
        readDirectory: (...args) => ts.sys.readDirectory(...args),
        directoryExists: (name) => ts.sys.directoryExists(name),
        getDirectories: (name) => ts.sys.getDirectories(name),
    }
    const languageService = ts.createLanguageService(host, ts.createDocumentRegistry())
    let exportsByDeclaration
    let entrySources = []
    let version = 0
    return {
        analyze(source, extension) {
            // One virtual file is replaced per block, so the SDK and Effect declarations stay parsed between blocks
            const name = join(sdkRoot, `.reference-code${extension}`).replaceAll("\\", "/")
            files.clear()
            files.set(name, { text: source, version: ++version })
            const program = languageService.getProgram()
            const checker = program.getTypeChecker()
            const sources = entries.map((entry) => program.getSourceFile(entry.file.replaceAll("\\", "/")))
            if (!exportsByDeclaration || sources.some((file, index) => file !== entrySources[index])) {
                entrySources = sources
                exportsByDeclaration = new Map()
                for (const [index, file] of sources.entries()) {
                    const module = file && checker.getSymbolAtLocation(file)
                    for (const exported of module ? checker.getExportsOfModule(module) : []) {
                        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
                        for (const declaration of target.declarations ?? [])
                            exportsByDeclaration.set(declaration, [...(exportsByDeclaration.get(declaration) ?? []), { entry: entries[index].name, name: exported.name }])
                    }
                }
            }
            return tokens(program.getSourceFile(name), checker, exportsByDeclaration)
        },
    }
}

/** The property that a destructured binding or object literal key names, from the type it is read from or written to */
function propertySymbol(node, checker) {
    const parent = node.parent
    if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) {
        const key = parent.propertyName && ts.isIdentifier(parent.propertyName) ? parent.propertyName.text : node.text
        return checker.getTypeAtLocation(parent.parent).getProperty(key)
    }
    if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === node && ts.isObjectLiteralExpression(parent.parent))
        return checker.getContextualType(parent.parent)?.getProperty(node.text)
    return undefined
}

function declaredSymbol(node, checker) {
    const property = propertySymbol(node, checker)
    if (property) return property
    let symbol = checker.getSymbolAtLocation(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    // A later use of a destructured parameter, such as reply(...), names the property it was read from
    const declaration = symbol?.valueDeclaration
    if (declaration && ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name) && declaration.name !== node)
        return propertySymbol(declaration.name, checker)
    return symbol
}

/** Candidate reference targets per identifier: a public export, or a member of a public class, interface or enum */
function tokens(file, checker, exportsByDeclaration) {
    const found = []
    const visit = (node) => {
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(node, checker)
            const declarations = symbol?.declarations ?? []
            const exported = declarations.flatMap((declaration) => exportsByDeclaration.get(declaration) ?? [])
            const owners = new Set(declarations.map((declaration) => declaration.parent))
            if (exported.length) found.push({ start: node.getStart(file), end: node.end, candidates: exported })
            else if (declarations.length && owners.size === 1) {
                const owner = [...owners][0]
                const ownerExports = owner && ownerKinds.has(owner.kind) ? exportsByDeclaration.get(owner) ?? [] : []
                if (ownerExports.length)
                    found.push({ start: node.getStart(file), end: node.end, candidates: ownerExports.map((target) => ({ ...target, member: symbol.name })) })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return found
}

const analyzed = new Map()

/** Identifier ranges in a code block that name public SDK API, with their candidate entries, or [] when unavailable */
export function analyzeCode(source, language) {
    const extension = languages.get(language)
    if (!extension) return []
    const key = `${extension}\0${source}`
    if (!analyzed.has(key)) {
        if (!service) {
            const entries = sdkEntries()
            if (entries.some((entry) => !existsSync(entry.file))) {
                if (!warned) console.warn("Code block reference previews are skipped because the SDK declarations are not built")
                warned = true
                return []
            }
            service = createService(entries)
        }
        analyzed.set(key, service.analyze(source, extension))
    }
    return analyzed.get(key)
}

/** Resolve one analyzed identifier to a URL in a version's reference, preferring entries the block imports */
export function tokenUrl(index, token, preference) {
    const ranked = [...token.candidates].sort((a, b) => rank(a.entry) - rank(b.entry))
    function rank(entry) {
        const position = preference.indexOf(entry)
        return position < 0 ? preference.length : position
    }
    for (const candidate of ranked) {
        const target = index.entries.get(candidate.entry)?.get(candidate.name)
        if (!target) continue
        if (!candidate.member) return target.url
        const member = index.pages.get(target.url)?.get(candidate.member)
        if (member) return member.url
    }
    return undefined
}

/** Entry points a block imports from, in import order, followed by the page's preference */
export function blockPreference(source, pagePreference) {
    const entries = sdkEntries()
    const imported = [...source.matchAll(/\b(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)]
        .map((match) => entries.find((entry) => entry.specifier === match[1])?.name)
        .filter(Boolean)
    return [...new Set([...imported, ...pagePreference])]
}

const plainText = (node) => node.type === "text" ? node.value : (node.children ?? []).map(plainText).join("")

/** Wrap text ranges of a highlighted code element in reference tokens, splitting only the text nodes they cover */
export function wrapRanges(code, ranges) {
    let offset = 0
    const visit = (parent) => {
        parent.children = parent.children.flatMap((child) => {
            if (child.type !== "text") {
                if (child.children) visit(child)
                return [child]
            }
            const start = offset
            const end = offset + child.value.length
            offset = end
            const inside = ranges.filter((range) => range.start >= start && range.end <= end)
            if (!inside.length) return [child]
            const parts = []
            let position = start
            for (const range of inside) {
                if (range.start > position) parts.push({ type: "text", value: child.value.slice(position - start, range.start - start) })
                parts.push({
                    type: "element", tagName: "span",
                    properties: { className: ["reference-token"], dataReference: range.url },
                    children: [{ type: "text", value: child.value.slice(range.start - start, range.end - start) }],
                })
                position = range.end
            }
            if (position < end) parts.push({ type: "text", value: child.value.slice(position - start) })
            return parts
        })
    }
    visit(code)
}

/**
 * Mark code block identifiers that name public SDK API with their reference URL for hover previews.
 * Runs after syntax highlighting. Tokens are spans rather than links, so code keeps its text selection and adds no tab stops
 */
export function rehypeReferenceCode() {
    return async function transform(root, file) {
        const context = pageContext(file?.path)
        if (!context) return
        const index = await referenceIndexFor(context)
        const blocks = []
        const find = (node) => {
            if (node.tagName === "pre") {
                const code = node.children?.find((child) => child.tagName === "code")
                const language = node.properties?.dataLanguage
                if (code && languages.has(language)) blocks.push({ code, language, text: plainText(code) })
                return
            }
            for (const child of node.children ?? []) find(child)
        }
        find(root)
        // Blocks without imports use the page's API. Example blocks are rendered one at a time and use their own
        const pagePreference = entryPreference(context.entry, importsOnlyEffect(blocks.map((block) => block.text)))
        for (const block of blocks) {
            const preference = blockPreference(block.text, pagePreference)
            const ranges = analyzeCode(block.text, block.language)
                .map((token) => ({ start: token.start, end: token.end, url: tokenUrl(index, token, preference) }))
                .filter((range) => range.url)
            if (ranges.length) wrapRanges(block.code, ranges)
        }
    }
}
