import { docsAliasFiles } from "./docs-alias.js"
import { parseVersion, snapshotSchemas } from "./versions.js"
import { currentSnapshotSchema, transformSchemas } from "./transform-schemas.js"

export { currentSnapshotSchema, snapshotSchemas, transformSchemas }
export const linkPlaceholder = "/docs/{{version}}"

function withSchema(content, schema) {
    const opening = /^---\r?\n/.exec(content)
    if (!opening) return `---\nsnapshotSchema: ${schema}\n---\n\n${content}`
    return `${opening[0]}snapshotSchema: ${schema}\n${content.slice(opening[0].length)}`
}

/**
 * Prepare generated snapshot files for one served documentation path.
 * The path is an exact Stable version, a rolling channel or the local source preview
 */
export function materializeFiles(files, { schemaVersion, sourceVersion, path }) {
    if (!snapshotSchemas.includes(schemaVersion)) throw new Error("Unsupported docs snapshot schema")
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(path)) throw new Error("Unsafe documentation path")
    let prepared
    if (schemaVersion === 1) {
        // Schema 1 links name the exact version, so only rolling channels rebase them
        parseVersion(sourceVersion)
        prepared = path === sourceVersion ? files.map((file) => ({ ...file })) : docsAliasFiles(files, sourceVersion, path)
    } else {
        prepared = files.map((file) => file.path.endsWith(".md")
            ? { ...file, content: file.content.replaceAll(linkPlaceholder, `/docs/${path}`) }
            : { ...file })
    }
    return prepared.map((file) => file.path.endsWith(".md") ? { ...file, content: withSchema(file.content, schemaVersion) } : file)
}
