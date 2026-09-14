const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

/** Reject unsupported metadata without including authored input in build errors */
export function validateCommand(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command metadata")
    const keys = Object.keys(value).sort().join(",")
    if (value.kind === "install" && keys === "kind,package,version" && value.package === "@neontechspace/fluxerly" &&
        (value.version === "dev" || (typeof value.version === "string" && exactVersion.test(value.version) && value.version !== "0.0.0"))) return value
    if (value.kind === "add" && keys === "kind,package,version" && value.package === "effect" &&
        typeof value.version === "string" && exactVersion.test(value.version)) return value
    if (value.kind === "list" && keys === "kind,package" && value.package === "effect") return value
    if (value.kind === "run" && keys === "command,kind" && value.command === "node bot.js") return value
    throw new Error("Invalid command metadata")
}

export function commandVariant(metadata, manager = "npm", language = "js") {
    const value = validateCommand(metadata)
    if (!["npm", "pnpm"].includes(manager) || !["js", "ts"].includes(language)) throw new Error("Invalid command preference")
    let command
    let note = ""
    if (value.kind === "install") {
        const version = value.version === "dev" ? "VERSION" : value.version
        if (value.version === "dev") note = "This Canary preview is not published. VERSION is a placeholder for a future release"
        command = `${manager === "npm" ? "npm install" : "pnpm add"} --save-exact ${value.package}@${version}`
    } else if (value.kind === "add") {
        command = `${manager === "npm" ? "npm install" : "pnpm add"} --save-exact ${value.package}@${value.version}`
    } else if (value.kind === "list") command = `${manager} list ${value.package}`
    else command = language === "ts" ? "node bot.ts" : value.command
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
<label>Package manager <select aria-label="Package manager" data-command-preference="manager" disabled><option value="npm">npm</option><option value="pnpm">pnpm</option></select></label>
<button type="button" data-command-copy hidden>Copy</button><span data-command-copy-status role="status"></span>
</div>
<pre tabindex="0"><code data-command-code>${escapeHtml(command)}</code></pre>
<p data-command-note aria-live="polite"${note ? "" : " hidden"}>${escapeHtml(note)}</p>
<p class="command-no-script" data-command-fallback>Enable JavaScript to change command preferences</p>
</div>`
}

export function remarkCommandBlocks() {
    return function transform(root) {
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
