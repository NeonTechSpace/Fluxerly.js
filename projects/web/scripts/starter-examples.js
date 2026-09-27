import { readFile } from "node:fs/promises"

const examplesRoot = new URL("../../sdk/examples/", import.meta.url)
const starterRoot = new URL("starter/", examplesRoot)
const files = new Set(["bot.js", "bot.ts", "bot-effect.ts"])
// Other example folders hold one flat level of JavaScript and TypeScript files
const examplePath = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*\.(?:js|ts))$/

/** Keep the rendered starter and example files identical to the exercised application files */
export async function expandStarterExamples(content) {
    const names = new Set([...content.matchAll(/\{\{starter:([^}]+)\}\}/g)].map((match) => match[1]))
    for (const name of names) {
        if (!files.has(name)) throw new Error("Unknown starter example")
        const source = await readFile(new URL(name, starterRoot), "utf8")
        content = content.replaceAll(`{{starter:${name}}}`, source.trimEnd())
    }
    if (content.includes("{{starter:")) throw new Error("Incomplete starter example marker")
    const paths = new Set([...content.matchAll(/\{\{example:([^}]+)\}\}/g)].map((match) => match[1]))
    for (const path of paths) {
        const match = examplePath.exec(path)
        if (!match || match[1] === "starter") throw new Error("Unknown example file")
        const source = await readFile(new URL(path, examplesRoot), "utf8")
        content = content.replaceAll(`{{example:${path}}}`, source.trimEnd())
    }
    if (content.includes("{{example:")) throw new Error("Incomplete example marker")
    return content
}
