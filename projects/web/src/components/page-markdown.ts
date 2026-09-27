let initialized = false

// Copy the page's generated Markdown twin. The link beside the button still works without JavaScript
export function setupPageMarkdown() {
    if (initialized) return
    initialized = true
    const setup = () => {
        const button = document.querySelector<HTMLButtonElement>("[data-copy-markdown]")
        const status = document.querySelector<HTMLElement>("[data-copy-markdown-status]")
        if (!button || !status || !navigator.clipboard) return
        button.hidden = false
        const copyMarkdown = async () => {
            const url = button.dataset.copyMarkdown!
            button.disabled = true
            status.textContent = ""
            try {
                const text = fetch(url, { credentials: "omit" }).then(async (response) => {
                    if (!response.ok) throw new Error("Markdown is unavailable")
                    return new Blob([await response.text()], { type: "text/plain" })
                })
                // Passing the pending blob keeps the click's clipboard permission in Safari
                if (typeof ClipboardItem === "function") await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })])
                else await navigator.clipboard.writeText(await (await text).text())
                status.textContent = "Copied"
            } catch {
                status.textContent = "Copy failed. Open the Markdown link instead"
            } finally {
                button.disabled = false
            }
        }
        button.addEventListener("click", () => {
            copyMarkdown().catch((error: unknown) => console.error("Markdown copy failed", error))
        })
    }
    document.addEventListener("astro:page-load", setup)
}
