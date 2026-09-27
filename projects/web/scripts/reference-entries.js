// Public SDK entry points rendered by the reference, in sidebar and landing order.
// `module` is TypeDoc's name for the declaration file, `name` is the generated URL segment and
// `title` is the page heading. Testing entry points hold test helpers rather than application API.
// Released snapshots keep the entries they were generated with, so readers must accept any subset of this list

/** @typedef {{ module: string, declarations: string, name: string, title: string, testing: boolean }} ReferenceEntry */

/** @type {readonly ReferenceEntry[]} */
export const referenceEntries = Object.freeze([
    { module: "index", declarations: "index.d.ts", name: "js-ts", title: "JavaScript & TypeScript", testing: false },
    { module: "effect", declarations: "effect.d.ts", name: "Effect", title: "Effect API", testing: false },
    { module: "testing", declarations: "testing.d.ts", name: "testing", title: "Testing", testing: true },
    { module: "effect-testing", declarations: "effect-testing.d.ts", name: "Effect-testing", title: "Effect testing", testing: true },
].map((entry) => Object.freeze(entry)))

// Names are letters and hyphens, so they need no escaping in patterns
const alternatives = (entries) => entries.map((entry) => entry.name).join("|")
const testingNames = alternatives(referenceEntries.filter((entry) => entry.testing))

/** Matches an entry point page URL and captures its generated name */
export const entryPointUrl = new RegExp(`/api/modules/(${alternatives(referenceEntries)})/?$`)

/** The entry point an entry point page URL belongs to, if any */
export function referenceEntryForUrl(url) {
    const name = entryPointUrl.exec(url)?.[1]
    return referenceEntries.find((entry) => entry.name === name)
}

/** Whether a generated reference page title is an entry point page rather than a symbol page */
export function isEntryPointTitle(title) {
    return referenceEntries.some((entry) => entry.title === title)
}

// Testing entry point pages and their own symbol pages, such as interfaces/testing.TestClient
const testingUrl = new RegExp(`/api/(?:modules/(?:${testingNames})(?:[/#?]|$)|[a-z]+/(?:${testingNames})[.])`)

/** Whether a reference URL belongs to a testing entry point */
export function isTestingReferenceUrl(url) {
    return testingUrl.test(url)
}
