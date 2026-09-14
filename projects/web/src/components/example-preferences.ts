export type ExampleLanguage = "js" | "ts"
export const exampleLanguageKey = "fluxerly.docs.example-language"
export const exampleLanguageEvent = "fluxerly:example-language"
let language: ExampleLanguage = "js"
let initialized = false

export function parseExampleLanguage(raw: string | null): ExampleLanguage {
    return raw === "ts" ? "ts" : "js"
}

export function getExampleLanguage(): ExampleLanguage { return language }

export function setupExamplePreferences() {
    if (initialized) return
    initialized = true
    let sessionOnly = false
    try { language = parseExampleLanguage(window.localStorage.getItem(exampleLanguageKey)) }
    catch { /* Keep readable JavaScript defaults when storage is unavailable */ }

    function updateExamples() {
        for (const block of document.querySelectorAll<HTMLElement>("[data-example-block]")) {
            const select = block.querySelector<HTMLSelectElement>("[data-example-language]")
            if (!select || !block.querySelector(`[data-example-variant="${language}"]`)) continue
            select.value = language
            select.disabled = false
            for (const variant of block.querySelectorAll<HTMLElement>("[data-example-variant]"))
                variant.hidden = variant.dataset.exampleVariant !== language
            const copy = block.querySelector<HTMLButtonElement>("[data-example-copy]")
            if (copy) copy.hidden = false
            const fallback = block.querySelector<HTMLElement>("[data-example-fallback]")
            if (fallback) fallback.hidden = true
            const status = block.querySelector<HTMLElement>("[data-example-copy-status]")
            if (status) status.textContent = ""
        }
        for (const filename of document.querySelectorAll<HTMLElement>("[data-example-filename]"))
            filename.textContent = language === "ts" ? "bot.ts" : "bot.js"
        document.dispatchEvent(new CustomEvent(exampleLanguageEvent))
    }

    document.addEventListener("change", (event) => {
        const select = event.target
        if (!(select instanceof HTMLSelectElement) || !select.matches("[data-example-language]") ||
            !select.closest("[data-example-block]") || !["js", "ts"].includes(select.value)) return
        language = select.value as ExampleLanguage
        try { window.localStorage.setItem(exampleLanguageKey, language) }
        catch { sessionOnly = true }
        updateExamples()
    })

    document.addEventListener("click", async (event) => {
        if (!(event.target instanceof Element)) return
        const button = event.target.closest<HTMLButtonElement>("[data-example-copy]")
        const block = button?.closest<HTMLElement>("[data-example-block]")
        const variant = block?.querySelector<HTMLElement>("[data-example-variant]:not([hidden])")
        const code = variant?.querySelector("pre code")
        const status = block?.querySelector<HTMLElement>("[data-example-copy-status]")
        if (!button || !variant || !code || !status || button.disabled) return
        const copied = code.textContent ?? ""
        button.disabled = true
        try {
            await navigator.clipboard.writeText(copied)
            status.textContent = variant.hidden ? "Previous example copied" : "Copied"
        } catch { status.textContent = "Copy failed. Select and copy the example manually" }
        finally { button.disabled = false }
    })

    window.addEventListener("storage", (event) => {
        if (event.key === exampleLanguageKey || event.key === null) {
            language = parseExampleLanguage(event.newValue)
            updateExamples()
        }
    })
    document.addEventListener("astro:page-load", updateExamples)
    window.addEventListener("pageshow", () => {
        if (!sessionOnly) {
            try { language = parseExampleLanguage(window.localStorage.getItem(exampleLanguageKey)) }
            catch { /* Preserve the selection for a restored page when storage is blocked */ }
        }
        updateExamples()
    })
    updateExamples()
}
