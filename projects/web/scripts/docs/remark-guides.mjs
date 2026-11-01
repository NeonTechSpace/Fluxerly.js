// Renders the docs' own Markdown markers. {{installation}} and fenced `command` blocks become a command chip with the
// npm, pnpm and Bun forms, {{starter:file}} and {{example:folder/file}} become the example bot's code, and default API
// examples in TypeScript get a JavaScript twin. The highlighter still colors every code block afterwards. The
// package manager and language choices are applied in the browser by src/lib/docs-client.ts
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"

// Bundled into the build's server chunks, this module no longer sits in scripts/docs, so the project root, where every
// build and test runs, finds the examples then
const contentRoots = [process.env.DOCS_CONTENT, resolve(import.meta.dirname, "../../content"), resolve(process.cwd(), "content")].filter(Boolean)
const examplesRoot = contentRoots.map((root) => resolve(root, "examples")).find((path) => existsSync(path)) ?? resolve(process.cwd(), "content/examples")
// Only the newest Stable's pages use the bare package name, all other published pages install their exact version
const packageSpec = process.env.DOCS_PACKAGE_SPEC ?? "@neontechspace/fluxerly"

// Bun ignores npm's --save-dev, and its `bun pm ls` ignores a package filter, so each manager names its own forms.
// Exec runs only an installed package and never downloads one, because the unscoped fluxerly name on npm is not this SDK
const managers = {
    npm: { label: "npm", add: "npm install", dev: "--save-dev", list: "npm list", exec: "npx --no", create: "npx" },
    pnpm: { label: "pnpm", add: "pnpm add", dev: "--save-dev", list: "pnpm list", exec: "pnpm exec", create: "pnpm dlx" },
    bun: { label: "Bun", add: "bun add", dev: "--dev", list: "bun why", exec: "bunx --no-install", create: "bunx" },
}

function command(metadata, manager) {
    const forms = managers[manager]
    switch (metadata.kind) {
        case "install":
            return `${forms.add} ${packageSpec}`
        case "init":
            return `${forms.create} ${packageSpec} init`
        case "add":
            return `${forms.add} ${metadata.package}`
        case "dev":
            return `${forms.add} ${forms.dev} ${metadata.package}`
        case "list":
            return `${forms.list} ${metadata.package}`
        case "agents":
            return `${forms.exec} fluxerly agents`
        default:
            throw new Error(`Unknown command block kind: ${metadata.kind}`)
    }
}

const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character])

// Phosphor's Copy and Check, the icons of the homepage's chips
const icon = (path, name) =>
    `<svg class="${name}" xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`
const copyButton =
    `<button class="copy-button" type="button" aria-label="Copy" data-copy>` +
    icon("M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z", "icon-copy") +
    icon("M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z", "icon-done") +
    `</button><span class="sr-only" aria-live="polite" data-copy-status></span>`

// Only the first form of a command chip is indexed, so search reads one command instead of three run together
const chipCode = (text, attributes, indexed = true) => {
    const [tool, ...rest] = text.split(" ")
    return `<code ${attributes}${indexed ? "" : " data-pagefind-ignore"} data-copy-text><span class="cmd-tool">${escape(tool)}</span> ${escape(rest.join(" "))}</code>`
}

function commandBlock(metadata) {
    if (metadata.kind === "run") {
        // The run command follows the code language: the TypeScript starter is bot.ts
        const typescript = metadata.command.replace(/bot\.js$/, "bot.ts")
        return `<div class="cmd-block"><div class="cmd-chip" data-copy-root>${chipCode(metadata.command, 'data-lang-variant="js"')}${chipCode(typescript, 'data-lang-variant="ts"', false)}${copyButton}</div></div>`
    }
    const switches = Object.entries(managers)
        .map(([id, { label }]) => `<button type="button" data-set-pm="${id}" aria-pressed="${id === "npm"}">${label}</button>`)
        .join("")
    const variants = Object.keys(managers)
        .map((id, index) => chipCode(command(metadata, id), `data-pm-variant="${id}"`, index === 0))
        .join("")
    return `<div class="cmd-block"><div class="seg" data-pagefind-ignore role="group" aria-label="Package manager">${switches}</div><div class="cmd-chip" data-copy-root>${variants}${copyButton}</div></div>`
}

// Effect examples stay TypeScript, as the Effect API is written for it
const isEffect = (source) => /\b(?:from\s*|import\s*\()["'](?:effect(?:\/[^"']*)?|@neontechspace\/fluxerly\/effect(?:\/[^"']*)?)["']/.test(source)

// TypeScript's output drops blank lines and adds semicolons. Marking blank lines as comments keeps them, and the
// semicolons go again, so the twin reads like the authored code
export function javascriptTwin(source) {
    const marked = source.replace(/^[ \t]*$/gm, "//__blank__")
    const { outputText } = ts.transpileModule(marked, {
        fileName: "example.mts",
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, newLine: ts.NewLineKind.LineFeed },
    })
    const twin = outputText
        .replace(/^[ \t]*\/\/__blank__$/gm, "")
        .replace(/;$/gm, "")
        .replace(/^export \{\}$/m, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    // Code that only declares types has no JavaScript form
    return twin.replace(/\/\/.*$/gm, "").trim() ? twin : null
}

const readExample = (path) => readFileSync(resolve(examplesRoot, path), "utf8").trimEnd()

const html = (value) => ({ type: "html", value })
const code = (lang, value) => ({ type: "code", lang, meta: null, value })

// Code counts for less than prose in search ranking, so a page that explains a word ranks above one that only uses it
const codeWeight = 'data-pagefind-weight="0.5"'

// A framed code block: an optional bar with the file name and the language switch, then the code, or one code node
// per language when it has a JavaScript and a TypeScript form
function codeFrame({ js, ts: typescript, source, lang, file }) {
    const twin = js !== undefined && typescript !== undefined
    const fileName = !file
        ? ""
        : twin
          ? `<span class="code-file"><span data-lang-variant="js" data-pagefind-ignore>${escape(file.replace(/\.ts$/, ".js"))}</span><span data-lang-variant="ts">${escape(file)}</span></span>`
          : `<span class="code-file">${escape(file)}</span>`
    const switches = twin
        ? `<div class="seg" data-pagefind-ignore role="group" aria-label="Language"><button type="button" data-set-lang="js" aria-pressed="true">JavaScript</button><button type="button" data-set-lang="ts" aria-pressed="false">TypeScript</button></div>`
        : ""
    const bar = fileName || switches ? `<div class="code-bar">${fileName}${switches}${copyButton}</div>` : `<div class="code-corner">${copyButton}</div>`
    const nodes = [html(`<figure class="code-frame${fileName || switches ? " has-bar" : ""}" data-copy-root>${bar}`)]
    if (twin) {
        nodes.push(html('<div class="code-variant" data-lang-variant="js" data-copy-text data-pagefind-ignore>'), code("js", js), html(`</div><div class="code-variant" data-lang-variant="ts" data-copy-text ${codeWeight}>`), code("ts", typescript), html("</div>"))
    } else {
        nodes.push(html(`<div class="code-variant" data-copy-text ${codeWeight}>`), code(lang, source), html("</div>"))
    }
    nodes.push(html("</figure>"))
    return nodes
}

// What a block fenced as plain text holds, so it can be colored like the code it is. A file of KEY=value lines is a
// .env file. A list of paths under a paragraph that names .gitignore or .dockerignore is that ignore file, and both
// get a bar with the file's name, as the feature pages show them. Lines that open with a timestamp are a log, and a
// command line is shell. Output such as an error message stays plain
const envLine = /^(?:\s*#.*|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=.*)$/
const logLine = /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\s+\S)/
const commandLine = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:node|npm|npx|pnpm|bun|bunx|git|docker|pm2|systemctl|journalctl|curl)\b/
const ignoreFile = /\.(gitignore|dockerignore)\b/
const textOf = (node) => (node?.type === "text" || node?.type === "inlineCode" ? node.value : (node?.children ?? []).map(textOf).join(""))

function plainBlock(value, previous) {
    const lines = value.split("\n").filter((line) => line.trim())
    if (!lines.length) return { lang: "text" }
    if (lines.some((line) => line.includes("=")) && lines.every((line) => envLine.test(line))) return { lang: "dotenv", file: ".env" }
    const named = ignoreFile.exec(textOf(previous))
    if (named && lines.every((line) => /^[!#]?[\w.*?/[\]-]+$/.test(line))) return { lang: "gitignore", file: `.${named[1]}` }
    if (lines.every((line) => logLine.test(line))) return { lang: "log" }
    if (lines.every((line) => commandLine.test(line))) return { lang: "sh" }
    return { lang: "text" }
}

function renderCode(node, previous) {
    let lang = node.lang ?? "text"
    const starter = /^\{\{starter:([\w.-]+)\}\}$/.exec(node.value.trim())
    if (starter) {
        const file = `starter/${starter[1]}`
        const source = readExample(file)
        if (isEffect(source)) return codeFrame({ source, lang: "ts" })
        const twin = file.replace(/\.(js|ts)$/, (_, ext) => (ext === "js" ? ".ts" : ".js"))
        const [js, typescript] = file.endsWith(".js") ? [source, readExample(twin)] : [readExample(twin), source]
        return codeFrame({ js, ts: typescript })
    }
    const example = /^\{\{example:([\w-]+\/[\w.-]+)\}\}$/.exec(node.value.trim())
    if (example) {
        const file = example[1]
        const source = readExample(file)
        const authoredTwin = resolve(examplesRoot, file.replace(/\.ts$/, ".js"))
        // An example bot ships its own JavaScript file, which its tests run, so that one is shown
        if (file.endsWith(".ts") && !isEffect(source))
            return codeFrame({ ts: source, js: existsSync(authoredTwin) ? readExample(file.replace(/\.ts$/, ".js")) : javascriptTwin(source), file })
        return codeFrame({ source, lang: file.endsWith(".js") ? "js" : "ts", file })
    }
    if (node.value.includes("{{")) throw new Error(`Unknown marker in a code block: ${node.value.slice(0, 60)}`)
    if ((lang === "ts" || lang === "typescript") && !isEffect(node.value)) {
        const js = javascriptTwin(node.value)
        if (js) return codeFrame({ js, ts: node.value })
    }
    if (lang === "text" || lang === "txt" || lang === "plaintext") {
        const plain = plainBlock(node.value, previous)
        return codeFrame({ source: node.value, lang: plain.lang, file: plain.file })
    }
    // A unit file is fenced as ini, but the systemd grammar keeps a value such as ExecStart whole
    if (lang === "ini" && /^\[(?:Unit|Service|Install)\]/m.test(node.value)) lang = "systemd"
    return codeFrame({ source: node.value, lang })
}

export default function remarkGuides() {
    return (tree) => {
        const visit = (parent) => {
            if (!Array.isArray(parent.children)) return
            for (let index = 0; index < parent.children.length; index++) {
                const node = parent.children[index]
                let replacement
                if (node.type === "code" && node.lang === "command") replacement = [html(commandBlock(JSON.parse(node.value)))]
                else if (node.type === "code") replacement = renderCode(node, parent.children[index - 1])
                else if (node.type === "paragraph" && node.children.length === 1 && node.children[0].value?.trim() === "{{installation}}")
                    replacement = [html(commandBlock({ kind: "install" }))]
                else if (node.type === "paragraph" && node.children.length === 1 && node.children[0].value?.trim() === "{{init}}")
                    replacement = [html(commandBlock({ kind: "init" }))]
                if (replacement) {
                    parent.children.splice(index, 1, ...replacement)
                    index += replacement.length - 1
                } else visit(node)
            }
        }
        visit(tree)
    }
}

/** A guide as plain Markdown for AI tools and for reading as text, with its markers filled in as the npm commands and the example's code */
export function guideAsMarkdown(source) {
    const [, head = "", body = source] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source) ?? []
    const title = /^title:\s*(.+)$/m.exec(head)?.[1]?.replace(/^["']|["']$/g, "")
    const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.replace(/^["']|["']$/g, "")
    const filled = body
        .replace(/^\{\{installation\}\}$/gm, () => "```sh\n" + command({ kind: "install" }, "npm") + "\n```")
        .replace(/^\{\{init\}\}$/gm, () => "```sh\n" + command({ kind: "init" }, "npm") + "\n```")
        .replace(/```command\n([\s\S]*?)\n```/g, (_, value) => {
            const metadata = JSON.parse(value)
            return "```sh\n" + (metadata.command ?? command(metadata, "npm")) + "\n```"
        })
        .replace(/\{\{starter:([\w.-]+)\}\}/g, (_, file) => readExample(`starter/${file}`))
        .replace(/\{\{example:([\w-]+\/[\w.-]+)\}\}/g, (_, file) => readExample(file))
    return `${title ? `# ${title}\n\n` : ""}${description ? `${description}\n\n` : ""}${filled.trim()}\n`
}
