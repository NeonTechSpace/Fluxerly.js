import assert from "node:assert/strict"

// Each repository example exports its options as bot and starts only when Node.js runs it, so a test can import it and
// pass the options to createTestBot without a token or a network
const [kind, ...files] = process.argv.slice(2)
assert.ok((kind === "default" || kind === "effect") && files.length > 0)
const { createTestBot } = await import(
    kind === "default" ? "@neontechspace/fluxerly/testing" : "@neontechspace/fluxerly/effect/testing"
)
for (const file of files) {
    const initialExitCode = process.exitCode
    const { bot } = await import(`./${file}`)
    assert.equal(typeof bot, "object", `${file} must export its options as bot`)
    assert.equal(process.exitCode, initialExitCode, `Importing ${file} must not start the bot`)
    // Creating the test bot registers the events and commands, which rejects invalid options, without running setup
    if (kind === "default") await createTestBot(bot)[Symbol.asyncDispose]()
    else {
        // The default consumer has no Effect installed
        const { Effect } = await import("effect")
        await Effect.runPromise(Effect.scoped(createTestBot(bot)))
    }
}
console.log(`Packed ${kind} repository examples passed import and test bot registration: ${files.length} files`)
