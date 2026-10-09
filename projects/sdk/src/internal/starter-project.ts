/**
 * Writes a ready-to-run starter bot project for `fluxerly init`, in JavaScript, TypeScript or TypeScript with the
 * native Effect API.
 * Invariant: Existing files are never replaced. A conflict writes nothing, and a failed write removes only the files
 * this run created. Two files are no conflict. An existing .env is kept, because it holds the bot's own token, and an
 * existing .gitignore is kept with only its missing starter lines appended, last, after every other file is written.
 * Each bot's handlers match its shipped starter in examples/starter
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { newAgentsFile } from "./agents-section.js"

/** The starters init writes, in the order the prompt offers them */
export const starterTemplates = ["js", "ts", "effect"] as const
export type StarterTemplate = (typeof starterTemplates)[number]

/** The lines the starter needs in .gitignore, so the token and the installed packages stay out of version control */
const ignoredLines = ["node_modules", ".env"]

/** Thrown when a file that init writes already exists. Nothing was written */
export class StarterConflictError extends Error {
    override readonly name = "StarterConflictError"
    constructor(readonly conflicts: readonly string[]) {
        super(`These files already exist: ${conflicts.join(", ")}`)
    }
}

const startComment = `// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code`

// Each bot exports its options without the token, so its test can run them through createTestBot without a token or a
// network. The events blocks match the shipped starters
const javaScriptBot = `import { runBot } from "@neontechspace/fluxerly"

export const bot = {
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
}

${startComment}
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
`

const typeScriptBot = `import { runBot, type BotOptions } from "@neontechspace/fluxerly"

export const bot: Omit<BotOptions, "token"> = {
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
}

${startComment}
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
`

// satisfies keeps the handlers' own error and service types, which runBot and createTestBot read
const effectBot = `import { Effect } from "effect"
import { runBot, type BotOptions } from "@neontechspace/fluxerly/effect"

export const bot = {
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return Effect.void
            // A failed reply is reported to the log without stopping the bot
            return reply("Pong!")
        },
    },
} satisfies Omit<BotOptions<unknown, unknown>, "token">

${startComment}
if (import.meta.main)
    await Effect.runPromiseExit(runBot({ token: process.env.FLUXER_BOT_TOKEN, processSignals: true, ...bot }))
`

const defaultTest = (botFile: string) => `import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"
import { bot } from "./${botFile}"

// createTestBot runs the bot against an in-memory Fluxer, so no token or network is needed
test("the bot answers !ping with Pong! and ignores other messages", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()

    // The say method sends a message as a user and returns the messages the bot sent in response
    assert.deepEqual((await testBot.say("!ping")).map((message) => message.content), ["Pong!"])
    assert.deepEqual(await testBot.say("hello"), [])
})
`

const effectTest = `import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { createTestBot } from "@neontechspace/fluxerly/effect/testing"
import { bot } from "./bot.ts"

// createTestBot runs the bot against an in-memory Fluxer, so no token or network is needed
test("the bot answers !ping with Pong! and ignores other messages", async () => {
    // Effect.scoped shuts the test bot down once the conversation ends
    const { ping, hello } = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const testBot = yield* createTestBot(bot)
                yield* testBot.ready()
                // The say method sends a message as a user and returns the messages the bot sent in response
                return { ping: yield* testBot.say("!ping"), hello: yield* testBot.say("hello") }
            }),
        ),
    )

    assert.deepEqual(ping.map((message) => message.content), ["Pong!"])
    assert.deepEqual(hello, [])
})
`

// Node.js runs .ts files directly by removing their types, so the scripts need no build step. Removing types checks
// nothing, so a TypeScript starter also gets a check script that runs the compiler
const packageJson = (botFile: string) =>
    `${JSON.stringify(
        {
            private: true,
            type: "module",
            scripts: {
                start: `node --env-file-if-exists=.env ${botFile}`,
                test: "node --test",
                ...(botFile.endsWith(".ts") ? { check: "tsc" } : {}),
            },
        },
        null,
        2,
    )}\n`

// TypeScript only checks the code, for editors and the check script. The last three settings keep it in a form Node.js
// can run directly
const tsconfig = `${JSON.stringify(
    {
        compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            types: ["node"],
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
            erasableSyntaxOnly: true,
        },
    },
    null,
    4,
)}\n`

/** The files init writes for a template, in the order it reports them */
function starterFiles(project: string, packageRoot: string, template: StarterTemplate): ReadonlyMap<string, string> {
    const shared = (): [string, string][] => [
        [".env.example", "FLUXER_BOT_TOKEN=\n"],
        [".env", "FLUXER_BOT_TOKEN=\n"],
        [".gitignore", `${ignoredLines.join("\n")}\n`],
        ["AGENTS.md", newAgentsFile(project, packageRoot)],
    ]
    if (template === "js")
        return new Map([
            ["package.json", packageJson("bot.js")],
            ["bot.js", javaScriptBot],
            ["bot.test.js", defaultTest("bot.js")],
            ...shared(),
        ])
    return new Map([
        ["package.json", packageJson("bot.ts")],
        ["tsconfig.json", tsconfig],
        ["bot.ts", template === "ts" ? typeScriptBot : effectBot],
        ["bot.test.ts", template === "ts" ? defaultTest("bot.ts") : effectTest],
        ...shared(),
    ])
}

/** What one run of writeStarterProject changed */
export interface StarterResult {
    /** The files this run created, in the order it wrote them */
    readonly written: readonly string[]
    /** The lines this run appended to an existing .gitignore. None when it had them all or did not exist */
    readonly ignored: readonly string[]
}

/** Append the starter's lines that `file` lacks, keeping its content and line endings, and return the lines added */
function addMissingIgnoredLines(file: string): readonly string[] {
    const text = readFileSync(file, "utf8")
    const present = new Set(text.split(/\r?\n/).map((line) => line.trim()))
    const missing = ignoredLines.filter((line) => !present.has(line))
    if (missing.length === 0) return []
    const lineEnd = text.includes("\r\n") ? "\r\n" : "\n"
    // A file that ends without a line break gets one first, so the added lines start on their own line
    const lead = text === "" || text.endsWith("\n") ? "" : lineEnd
    appendFileSync(file, `${lead}${missing.map((line) => `${line}${lineEnd}`).join("")}`)
    return missing
}

/** Write a starter project into `project` and report what changed, or throw StarterConflictError */
export function writeStarterProject(
    project: string,
    packageRoot: string,
    template: StarterTemplate = "js",
): StarterResult {
    const files = starterFiles(project, packageRoot, template)
    const conflicts = [...files.keys()].filter(
        (name) => name !== ".env" && name !== ".gitignore" && existsSync(join(project, name)),
    )
    if (conflicts.length > 0) throw new StarterConflictError(conflicts)
    const written: string[] = []
    let ignored: readonly string[] = []
    let current = ""
    try {
        // The wx flag refuses a file that appeared after the check, so a concurrent writer's file is never replaced.
        // A file counts as created once opened, so a failed write removes its partial content
        for (const [name, text] of files) {
            current = name
            let descriptor: number
            try {
                descriptor = openSync(join(project, name), "wx")
            } catch (error) {
                // An existing .env holds the bot's own token, so it is kept. An existing .gitignore is kept too, and
                // gets its missing lines below
                const keep = name === ".env" || name === ".gitignore"
                if (keep && (error as NodeJS.ErrnoException).code === "EEXIST") continue
                throw error
            }
            written.push(name)
            try {
                writeFileSync(descriptor, text)
            } finally {
                closeSync(descriptor)
            }
        }
        // Last, so a failure above leaves the user's .gitignore as it was
        if (!written.includes(".gitignore")) ignored = addMissingIgnoredLines(join(project, ".gitignore"))
    } catch (error) {
        for (const name of written) rmSync(join(project, name), { force: true })
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StarterConflictError([current])
        throw error
    }
    return { written, ignored }
}
