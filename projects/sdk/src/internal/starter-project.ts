/**
 * Writes a ready-to-run starter bot project for `fluxerly init`.
 * Invariant: Existing files are never replaced. A conflict writes nothing, and a failed write removes only the files
 * this run created. The bot's handlers match the shipped starter in examples/starter/bot.js
 */

import { closeSync, existsSync, openSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { newAgentsFile } from "./agents-section.js"

/** Thrown when a file that init writes already exists. Nothing was written */
export class StarterConflictError extends Error {
    override readonly name = "StarterConflictError"
    constructor(readonly conflicts: readonly string[]) {
        super(`These files already exist: ${conflicts.join(", ")}`)
    }
}

// The bot exports its handlers so its test can run them through createTestBot without a token or a network
const bot = `import { runBot } from "@neontechspace/fluxerly"

export const bot = {
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
}

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
`

const botTest = `import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestBot } from "@neontechspace/fluxerly/testing"
import { bot } from "./bot.js"

// createTestBot runs the bot against an in-memory Fluxer, so no token or network is needed
test("the bot answers !ping with Pong! and ignores other messages", async () => {
    await using testBot = createTestBot(bot)
    await testBot.ready()

    // The say method sends a message as a user and returns the messages the bot sent in response
    assert.deepEqual((await testBot.say("!ping")).map((message) => message.content), ["Pong!"])
    assert.deepEqual(await testBot.say("hello"), [])
})
`

const packageJson = `${JSON.stringify(
    {
        private: true,
        type: "module",
        scripts: { start: "node --env-file-if-exists=.env bot.js", test: "node --test" },
    },
    null,
    2,
)}\n`

/** The files init writes, in the order it reports them */
function starterFiles(project: string, packageRoot: string): ReadonlyMap<string, string> {
    return new Map([
        ["package.json", packageJson],
        ["bot.js", bot],
        ["bot.test.js", botTest],
        [".env.example", "FLUXER_BOT_TOKEN=\n"],
        [".gitignore", "node_modules\n.env\n"],
        ["AGENTS.md", newAgentsFile(project, packageRoot)],
    ])
}

/** Write the starter project into `project` and return the written file names, or throw StarterConflictError */
export function writeStarterProject(project: string, packageRoot: string): readonly string[] {
    const files = starterFiles(project, packageRoot)
    const conflicts = [...files.keys()].filter((name) => existsSync(join(project, name)))
    if (conflicts.length > 0) throw new StarterConflictError(conflicts)
    const written: string[] = []
    try {
        // The wx flag refuses a file that appeared after the check, so a concurrent writer's file is never replaced.
        // A file counts as created once opened, so a failed write removes its partial content
        for (const [name, text] of files) {
            const descriptor = openSync(join(project, name), "wx")
            written.push(name)
            try {
                writeFileSync(descriptor, text)
            } finally {
                closeSync(descriptor)
            }
        }
    } catch (error) {
        for (const name of written) rmSync(join(project, name), { force: true })
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new StarterConflictError([[...files.keys()][written.length]!])
        throw error
    }
    return written
}
