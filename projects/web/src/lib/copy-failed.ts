// A browser can refuse the clipboard, so a copy button that fails says so instead of doing nothing. The real reason goes
// to the console and the reader gets one short note, the same for every copy button on the site
let note: HTMLElement | undefined
let hide = 0

export function reportCopyFailed(error: unknown) {
    console.error("Copying to the clipboard failed", error)
    if (!note) {
        note = document.createElement("div")
        note.className = "copy-failed"
        note.setAttribute("role", "status")
        document.body.append(note)
    }
    note.textContent = "Couldn't copy that. Select the text and copy it by hand"
    note.dataset.shown = ""
    window.clearTimeout(hide)
    hide = window.setTimeout(() => delete note?.dataset.shown, 4000)
}
