import { parsers } from "prettier/plugins/typescript"

export async function guideImportSpecifiers(source) {
    // Reuse the formatter's parser rather than matching multiline syntax with a backtracking regex
    const program = await parsers.typescript.parse(source, {})
    return new Set(program.body.filter((node) => node.type === "ImportDeclaration").map((node) => node.source.value))
}
