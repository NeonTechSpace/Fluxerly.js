import ts from "typescript"
import { createMarkdownProcessor } from "@astrojs/markdown-remark"

const languages = new Map([["js", "js"], ["javascript", "js"], ["ts", "ts"], ["typescript", "ts"]])
let renderer
const rendered = new Map()

/** Keep runtime imports and modern syntax while removing only TypeScript syntax */
export function exampleVariants(source, language) {
    const normalized = languages.get(language)
    if (!normalized || typeof source !== "string") throw new Error("Unsupported example language")
    if (normalized === "js") return { js: source, ts: source }
    const parsed = ts.createSourceFile("example.mts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if (parsed.parseDiagnostics.length) throw new Error("TypeScript example conversion failed: Invalid syntax")
    const result = ts.transpileModule(source, {
        fileName: "example.mts",
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            verbatimModuleSyntax: true,
            newLine: ts.NewLineKind.LineFeed,
        },
    })
    if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
        throw new Error("TypeScript example conversion failed: Compiler diagnostics")
    return { js: result.outputText.trimEnd(), ts: source }
}

async function highlighted(source, language) {
    const key = `${language}\0${source}`
    if (!rendered.has(key)) {
        renderer ??= createMarkdownProcessor({ smartypants: false })
        rendered.set(key, (async () => {
            const processor = await renderer
            // A longer fence cannot be closed by code containing Markdown fences
            const fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map((match) => match[0].length + 1)))
            const result = await processor.render(`${fence}${language}\n${source}\n${fence}`)
            return result.code
        })())
    }
    return rendered.get(key)
}

export async function renderExampleBlock(source, language) {
    const variants = exampleVariants(source, language)
    const [javascript, typescript] = await Promise.all([highlighted(variants.js, "js"), highlighted(variants.ts, "ts")])
    return `<div class="example-block" data-example-block>
<div class="example-controls"><label>Language <select aria-label="Example language" data-example-language disabled><option value="js">JavaScript</option><option value="ts">TypeScript</option></select></label><button type="button" data-example-copy hidden>Copy</button><span data-example-copy-status role="status"></span></div>
<div data-example-variant="js">${javascript}</div>
<div data-example-variant="ts" hidden>${typescript}</div>
<p data-example-fallback>Enable JavaScript to change the example language</p>
</div>`
}

/** Effect-native examples retain their canonical TypeScript without a JavaScript option */
export function isEffectExample(source, filePath = "") {
    const path = String(filePath).replaceAll("\\", "/")
    return /\/(?:modules\/Effect(?:\.md|\/)|[^/]+\/Effect\.)/.test(path) ||
        /\b(?:from\s*|import\s*\()["'](?:effect(?:\/[^"']*)?|@neontechspace\/fluxerly\/effect)["']/.test(source)
}

function isExecutableExample(source, language) {
    if (languages.get(language) === "js") return true
    const parsed = ts.createSourceFile("example.mts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // Malformed runnable snippets still reach the conversion error, rather than disappearing silently
    if (parsed.parseDiagnostics.length) return true
    return parsed.statements.some((statement) => {
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false
        if (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false
        if (ts.isImportDeclaration(statement) && statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return false
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) return false
        return true
    })
}

export function remarkExampleBlocks() {
    return async function transform(root, file) {
        await visit(root)
        async function visit(node) {
            if (!Array.isArray(node.children)) return
            for (let index = 0; index < node.children.length; index++) {
                const child = node.children[index]
                if (child.type === "code" && languages.has(child.lang) && !isEffectExample(child.value, file?.path) &&
                    isExecutableExample(child.value, child.lang)) {
                    try { node.children[index] = { type: "html", value: await renderExampleBlock(child.value, child.lang) } }
                    catch (error) {
                        // File and line identify the owner without exposing code or private literals
                        const location = `${file?.path ?? "Markdown"}:${child.position?.start?.line ?? "?"}`
                        throw new Error(`Example rendering failed at ${location}`, { cause: error })
                    }
                } else await visit(child)
            }
        }
    }
}
