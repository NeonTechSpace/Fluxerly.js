import { pageSchema, requireTransformSchema } from "./transform-schemas.js"
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

// Released guide snapshots still use the plain form, so both stay accepted
const runCommands = ["node --env-file=.env bot.js", "node bot.js"]

/** Reject unsupported metadata without including authored input in build errors */
export function validateCommand(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command metadata")
    const keys = Object.keys(value).sort().join(",")
    if (value.kind === "install" && keys === "kind,package,version" && value.package === "@neontechspace/fluxerly" &&
        typeof value.version === "string" && exactVersion.test(value.version) && value.version !== "0.0.0") return value
    if (value.kind === "add" && keys === "kind,package,version" && value.package === "effect" &&
        typeof value.version === "string" && exactVersion.test(value.version)) return value
    if (value.kind === "list" && keys === "kind,package" && value.package === "effect") return value
    if (value.kind === "dev" && keys === "kind,package" && value.package === "@types/node") return value
    if (value.kind === "agents" && keys === "kind") return value
    if (value.kind === "run" && keys === "command,kind" && runCommands.includes(value.command)) return value
    throw new Error("Invalid command metadata")
}

// Bun ignores npm's --save-exact and --save-dev without an error, so each manager names its own flags. Its `bun pm ls` ignores a
// package filter, while `bun why` prints the installed version
export const packageManagers = {
    npm: { add: "npm install", exact: "--save-exact", dev: "--save-dev", list: "npm list", exec: "npx" },
    pnpm: { add: "pnpm add", exact: "--save-exact", dev: "--save-dev", list: "pnpm list", exec: "pnpm exec" },
    bun: { add: "bun add", exact: "--exact", dev: "--dev", list: "bun why", exec: "bunx" },
}

export function commandVariant(metadata, manager = "npm", language = "js") {
    const value = validateCommand(metadata)
    if (!Object.hasOwn(packageManagers, manager) || !["js", "ts"].includes(language)) throw new Error("Invalid command preference")
    const commands = packageManagers[manager]
    let command
    let note = ""
    // A prerelease's API can change between versions, so its install pins the exact version, and a Stable install keeps
    // the package manager's normal range. Older SDKs required one exact Effect release candidate, which stays pinned
    if (value.kind === "install" || value.kind === "add") {
        const exact = value.version.includes("-")
        command = `${commands.add}${exact ? ` ${commands.exact}` : ""} ${value.package}@${value.version}`
    } else if (value.kind === "agents") command = `${commands.exec} fluxerly agents`
    else if (value.kind === "dev") command = `${commands.add} ${commands.dev} ${value.package}`
    else if (value.kind === "list") command = `${commands.list} ${value.package}`
    else command = language === "ts" ? value.command.replace(/bot\.js$/, "bot.ts") : value.command
    return { command, note }
}

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character])
}

export function renderCommandBlock(metadata) {
    const value = validateCommand(metadata)
    const { command, note } = commandVariant(value)
    return `<div class="command-block" data-command-block data-command="${escapeHtml(JSON.stringify(value))}">
<div class="command-controls">
<label>Package manager <select aria-label="Package manager" data-command-preference="manager" disabled>${Object.keys(packageManagers).map((name) => `<option value="${name}">${name}</option>`).join("")}</select></label>
<button type="button" data-command-copy hidden>Copy</button><span data-command-copy-status role="status"></span>
</div>
<pre tabindex="0"><code data-command-code>${escapeHtml(command)}</code></pre>
<p data-command-note aria-live="polite"${note ? "" : " hidden"}>${escapeHtml(note)}</p>
<p class="command-no-script" data-command-fallback>Enable JavaScript to change command preferences</p>
</div>`
}

export function remarkCommandBlocks() {
    return function transform(root, file) {
        requireTransformSchema("commandBlocks", pageSchema(file))
        visit(root)
        function visit(node) {
            if (!Array.isArray(node.children)) return
            for (let index = 0; index < node.children.length; index++) {
                const child = node.children[index]
                if (child.type === "code" && child.lang === "command") {
                    let metadata
                    try { metadata = JSON.parse(child.value) } catch { throw new Error("Invalid command metadata") }
                    node.children[index] = { type: "html", value: renderCommandBlock(metadata) }
                } else visit(child)
            }
        }
    }
}
