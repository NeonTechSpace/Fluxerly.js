import { readFile } from "node:fs/promises"

const starterRoot = new URL("../../sdk/examples/starter/", import.meta.url)
const files = new Set(["bot.js", "bot.ts", "bot-effect.ts"])

/** Keep the rendered starter and the exercised application files identical */
export async function expandStarterExamples(content) {
    const names = new Set([...content.matchAll(/\{\{starter:([^}]+)\}\}/g)].map((match) => match[1]))
    for (const name of names) {
        if (!files.has(name)) throw new Error("Unknown starter example")
        const source = await readFile(new URL(name, starterRoot), "utf8")
        content = content.replaceAll(`{{starter:${name}}}`, source.trimEnd())
    }
    if (content.includes("{{starter:")) throw new Error("Incomplete starter example marker")
    return content
}
