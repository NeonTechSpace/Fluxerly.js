import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { ConfigurationError, fileSessionStore, type SessionSnapshot } from "../../src/index.js"
import { fileSessionStore as nativeFileSessionStore } from "../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"

/** A new empty directory removed when the current test finishes */
async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-sessions-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    return directory
}

const snapshot: SessionSnapshot = Object.freeze({
    sessionId: "synthetic-session-id",
    sequence: 7,
    resumeUrl: "wss://gateway.fluxer.app/?v=1&encoding=json",
    savedAt: 1_700_000_000_000,
    totalShards: 2,
})

describe("fileSessionStore", () => {
    test("returns what each shard saved, undefined for a shard without a file, and replaces an earlier save", async () => {
        const directory = await temporaryDirectory()
        const store = fileSessionStore(join(directory, "nested", "sessions"))
        expect(await store.load(0)).toBeUndefined()
        await store.save(0, snapshot)
        await store.save(1, { ...snapshot, sequence: 9 })
        await store.save(0, { ...snapshot, sequence: 8 })
        expect(await store.load(0)).toEqual({ ...snapshot, sequence: 8 })
        expect(await store.load(1)).toEqual({ ...snapshot, sequence: 9 })
        // A second store over the same directory, as after a restart, reads the same files
        expect(await fileSessionStore(pathToFileURL(join(directory, "nested", "sessions"))).load(1)).toEqual({
            ...snapshot,
            sequence: 9,
        })
        // Writes went through temporary files that were renamed, so only the shard files remain
        expect((await readdir(join(directory, "nested", "sessions"))).sort()).toEqual(["shard-0.json", "shard-1.json"])
    })

    test.skipIf(process.platform === "win32")("creates snapshot files readable only by their owner", async () => {
        const directory = await temporaryDirectory()
        await fileSessionStore(directory).save(3, snapshot)
        expect((await stat(join(directory, "shard-3.json"))).mode & 0o777).toBe(0o600)
    })

    test("creates nothing before the first save", async () => {
        const directory = await temporaryDirectory()
        const store = fileSessionStore(join(directory, "sessions"))
        expect(await store.load(0)).toBeUndefined()
        expect(await readdir(directory)).toEqual([])
    })

    test("rejects a corrupt file without quoting its contents, and a failed save leaves the previous file", async () => {
        const directory = await temporaryDirectory()
        const store = fileSessionStore(directory)
        await writeFile(join(directory, "shard-0.json"), '{"sessionId":"secret-looking-session')
        const failure = await store.load(0).then(
            () => expect.fail("A corrupt file must reject"),
            (error: unknown) => error as Error,
        )
        expect(failure.message).toContain("shard-0.json")
        expect(failure.message).not.toContain("secret-looking-session")
        expect(failure.cause).toBeUndefined()

        await store.save(1, snapshot)
        const unserializable = { ...snapshot, sequence: 1n } as unknown as SessionSnapshot
        await expect(store.save(1, unserializable)).rejects.toBeInstanceOf(TypeError)
        expect(await store.load(1)).toEqual(snapshot)
        expect((await readdir(directory)).sort()).toEqual(["shard-0.json", "shard-1.json"])
    })

    test("rejects an empty path or a URL that is not a file URL with ConfigurationError", () => {
        expect(() => fileSessionStore("")).toThrow(ConfigurationError)
        expect(() => fileSessionStore(new URL("https://example.com/sessions/"))).toThrow(ConfigurationError)
        expect(() => fileSessionStore(42 as never)).toThrow(ConfigurationError)
    })
})

/** Connect a test client that persists sessions in the directory, shut it down and return its gateway commands */
async function runOnce(mode: Mode, directory: string) {
    const sharding = {
        totalShards: 1,
        sessions: mode === "default" ? fileSessionStore(directory) : nativeFileSessionStore(directory),
    }
    if (mode === "default") {
        const test = createDefaultTestClient({ sharding })
        await test.ready()
        await test.shutdown()
        return test.commands()
    }
    const scope = Scope.makeUnsafe()
    const test = await Effect.runPromise(createNativeTestClient({ sharding }).pipe(Scope.provide(scope)))
    await Effect.runPromise(test.ready())
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return test.commands()
}

describe.each(modes)("%s client with fileSessionStore", (mode) => {
    test("resumes the session it saved at shutdown after a restart", async () => {
        const directory = await temporaryDirectory()
        const first = await runOnce(mode, directory)
        expect(first.map((command) => command.op)).toContain(2)
        const saved = JSON.parse(await readFile(join(directory, "shard-0.json"), "utf8")) as SessionSnapshot
        const second = await runOnce(mode, directory)
        // The restarted client first tries to resume the saved session. Its new test gateway never held that session,
        // so the client then identifies, as it would after Fluxer's retention window
        expect(second[0]).toMatchObject({ op: 6, d: { session_id: saved.sessionId } })
    })
})
