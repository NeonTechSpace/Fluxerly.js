// The sidebar is a sheet on narrow screens, opened from the Docs menu button. Docs.astro runs this in the head and it listens
// on the document, so the button answers from the first frame it is drawn in. In docs-client.ts, a module that runs once the
// whole page is parsed, a tap on the drawn button did nothing for most of a second on the changelog on a phone
//
// While the sheet is open, the page behind it is out of reach, so keyboard focus stays in the sheet. The scrim behind it still
// takes a tap to close it. Search opens its dialog from inside the sheet, so it keeps working

{
    // The page's root carries data-side-open too while the sheet is open, so the button is looked for as a button
    const root = document.documentElement
    let behindSheet = []
    const holdPageBehindSheet = (sheet, hold) => {
        for (const element of behindSheet) element.removeAttribute("inert")
        behindSheet = []
        if (!hold) return
        for (let at = sheet; at.parentElement && at !== document.body; at = at.parentElement) {
            behindSheet.push(...[...at.parentElement.children].filter((other) => other !== at && !other.hasAttribute("inert") && !other.hasAttribute("data-side-close")))
        }
        for (const element of behindSheet) element.setAttribute("inert", "")
    }
    const setSide = (open) => {
        const side = document.querySelector("[data-side]")
        const opener = document.querySelector("button[data-side-open]")
        if (!side || !opener) return
        side.toggleAttribute("data-open", open)
        root.toggleAttribute("data-side-open", open)
        opener.setAttribute("aria-expanded", String(open))
        holdPageBehindSheet(side, open)
        if (open) (document.querySelector("[data-part]:not([hidden]) a[aria-current='page']") ?? side.querySelector("input, button"))?.focus({ preventScroll: true })
        else opener.focus()
    }
    document.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return
        if (event.target.closest("button[data-side-open]")) setSide(true)
        else if (event.target.closest("[data-side-close]")) setSide(false)
    })
    // A sheet opened while the page was still arriving holds the parts that came after it out of reach too
    document.addEventListener("DOMContentLoaded", () => {
        const side = document.querySelector("[data-side]")
        if (side?.hasAttribute("data-open")) holdPageBehindSheet(side, true)
    })
    // A window that grows past the sheet's width shows the sidebar in the page, so the sheet ends and the page is back in reach
    matchMedia("(max-width: 899px)").addEventListener("change", (event) => {
        if (!event.matches && document.querySelector("[data-side][data-open]")) setSide(false)
    })
    // Escape that search already used to close its dialog, or the version menu to close itself, leaves the sheet open. On the
    // window, so the version menu's listener on the document, which comes later, has its say first
    addEventListener("keydown", (event) => {
        if (event.defaultPrevented) return
        if (event.key === "Escape" && document.querySelector("[data-side][data-open]") && !document.querySelector("dialog[open]")) setSide(false)
    })
}
