import { commandVariant } from "../../scripts/command-blocks.mjs"
import { exampleLanguageEvent, getExampleLanguage } from "./example-preferences.ts"

type Preferences = { manager: "npm" | "pnpm" }
export const commandPreferencesKey = "fluxerly.docs.command-preferences"
const defaults: Preferences = { manager: "npm" }
let initialized = false

export function parseCommandPreferences(raw: string | null): Preferences {
    try {
        const value = JSON.parse(raw ?? "null")
        if (value?.manager === "npm" || value?.manager === "pnpm") return { manager: value.manager }
    } catch { /* Malformed preferences use readable defaults */ }
    return { ...defaults }
}

export function setupCommandPreferences() {
    if (initialized) return
    initialized = true
    let preferences: Preferences
    let sessionOnly = false
    try { preferences = parseCommandPreferences(window.localStorage.getItem(commandPreferencesKey)) }
    catch { preferences = { ...defaults } }

    function updateBlocks() {
        for (const block of document.querySelectorAll<HTMLElement>("[data-command-block]")) {
            try {
                const variant = commandVariant(JSON.parse(block.dataset.command ?? "null"), preferences.manager, getExampleLanguage())
                const code = block.querySelector<HTMLElement>("[data-command-code]")
                const note = block.querySelector<HTMLElement>("[data-command-note]")
                if (!code || !note) continue
                code.textContent = variant.command
                note.textContent = variant.note
                note.hidden = !variant.note
                for (const select of block.querySelectorAll<HTMLSelectElement>("select[data-command-preference]")) {
                    const name = select.dataset.commandPreference
                    if (name !== "manager") continue
                    select.value = preferences[name]
                    select.disabled = false
                }
                const copy = block.querySelector<HTMLButtonElement>("[data-command-copy]")
                if (copy) copy.hidden = false
                const fallback = block.querySelector<HTMLElement>("[data-command-fallback]")
                if (fallback) fallback.hidden = true
                const status = block.querySelector<HTMLElement>("[data-command-copy-status]")
                if (status) status.textContent = ""
            } catch { /* Leave malformed blocks static and inert */ }
        }
    }

    document.addEventListener("change", (event) => {
        const select = event.target
        if (!(select instanceof HTMLSelectElement) || !select.closest("[data-command-block]")) return
        const name = select.dataset.commandPreference
        if (name === "manager" && (select.value === "npm" || select.value === "pnpm")) preferences.manager = select.value
        else return
        try { window.localStorage.setItem(commandPreferencesKey, JSON.stringify(preferences)) }
        catch { sessionOnly = true }
        updateBlocks()
    })

    document.addEventListener("click", async (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const button = target.closest<HTMLButtonElement>("button[data-command-copy]")
        const block = button?.closest<HTMLElement>("[data-command-block]")
        const code = block?.querySelector<HTMLElement>("[data-command-code]")
        const status = block?.querySelector<HTMLElement>("[data-command-copy-status]")
        if (!button || !code || !status || button.disabled) return
        const command = code.textContent ?? ""
        button.disabled = true
        try {
            await navigator.clipboard.writeText(command)
            status.textContent = code.textContent === command ? "Copied" : "Previous command copied"
        } catch { status.textContent = "Copy failed. Select and copy the command manually" }
        finally { button.disabled = false }
    })

    window.addEventListener("storage", (event) => {
        if (event.key === commandPreferencesKey || event.key === null) {
            preferences = parseCommandPreferences(event.newValue)
            updateBlocks()
        }
    })
    document.addEventListener("astro:page-load", updateBlocks)
    document.addEventListener(exampleLanguageEvent, updateBlocks)
    window.addEventListener("pageshow", () => {
        if (!sessionOnly) {
            try { preferences = parseCommandPreferences(window.localStorage.getItem(commandPreferencesKey)) }
            catch { /* Keep in-memory preferences when a restored page cannot access storage */ }
        }
        updateBlocks()
    })
    updateBlocks()
}
