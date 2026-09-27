// This module is also bundled for the browser through command-blocks.js, so it has no imports

// Schema 1 snapshots contain exact-version documentation links.
// Schema 2 snapshots write every documentation link as /docs/{{version}}/, filled with the served path
export const currentSnapshotSchema = 2

// Build-time Markdown transforms list the snapshot schemas whose generated syntax they read.
// A transform change that alters accepted syntax needs a new schema, with older schemas kept readable
export const transformSchemas = Object.freeze({
    commandBlocks: Object.freeze([1, 2]),
    exampleBlocks: Object.freeze([1, 2]),
    referenceAnchors: Object.freeze([1, 2]),
})

// Generated pages record their snapshot schema in frontmatter. Direct transform calls use the current schema
export function pageSchema(file) {
    const value = file?.data?.astro?.frontmatter?.snapshotSchema
    return value === undefined ? currentSnapshotSchema : value
}

export function requireTransformSchema(transform, schema) {
    const schemas = transformSchemas[transform]
    if (!schemas) throw new Error("Unknown snapshot transform")
    if (!schemas.includes(schema)) throw new Error(`The ${transform} transform cannot read snapshot schema ${schema}`)
}
