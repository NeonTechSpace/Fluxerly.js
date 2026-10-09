import { mkdtemp, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { ConfigurationError, fileSessionStore, type SessionSnapshot } from "../../src/index.js"
import { fileSessionStore as nativeFileSessionStore } from "../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { sdkClock, type SdkClock } from "../support/client-clock.js"

/**
 * Failures the next save meets in the file system calls the store makes. Every other call reaches the real file
 * system, so the temporary directory, its files and the handles are real. A fault leaves what the store had written
 * before it, as a failing disk does, and records how many bytes the temporary file held at that moment
 */
const faults = vi.hoisted(() => ({
    write: undefined as Error | undefined,
    sync: undefined as Error | undefined,
    rename: undefined as Error | undefined,
    handles: [] as FileHandle[],
    temporaryBytes: [] as number[],
}))

vi.mock("node:fs/promises", async (original) => {
    const fs = await original<typeof import("node:fs/promises")>()
    return {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args)
            faults.handles.push(handle)
            const writeFile = handle.writeFile.bind(handle)
            const sync = handle.sync.bind(handle)
            handle.writeFile = (async (data: string) => {
                if (!faults.write) return writeFile(data)
                await writeFile(data.slice(0, Math.ceil(data.length / 2)))
                faults.temporaryBytes.push((await handle.stat()).size)
                throw faults.write
            }) as typeof handle.writeFile
            handle.sync = async () => {
                if (!faults.sync) return sync()
                faults.temporaryBytes.push((await handle.stat()).size)
                throw faults.sync
            }
            return handle
        },
        rename: async (...args: Parameters<typeof fs.rename>) => {
            if (!faults.rename) return fs.rename(...args)
            faults.temporaryBytes.push((await fs.stat(args[0])).size)
            throw faults.rename
        },
    }
})

afterEach(() => {
    faults.write = faults.sync = faults.rename = undefined
    faults.handles = []
    faults.temporaryBytes = []
    vi.restoreAllMocks()
})

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

/** A file system error with a Node.js code */
function failure(code: string): Error {
    return Object.assign(new Error(`${code}: injected file system failure`), { code })
}

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

    test.each([
        { stage: "disk write after partial output", fault: "write", error: failure("ENOSPC") },
        { stage: "sync after the full output was written", fault: "sync", error: failure("EIO") },
        { stage: "rename after the output was flushed", fault: "rename", error: failure("EPERM") },
    ] as const)(
        "keeps the previous snapshot readable, closes the handle and removes the temporary file when the $stage fails",
        async ({ fault, error }) => {
            const directory = await temporaryDirectory()
            const store = fileSessionStore(directory)
            await store.save(0, snapshot)
            faults.handles = []
            faults[fault] = error
            const replacement = { ...snapshot, sequence: 99 }
            // The caller sees the file system error itself, so the SDK logs the real cause
            await expect(store.save(0, replacement)).rejects.toBe(error)
            // The fault struck with real output on disk, so the cleanup below has something to remove
            expect(faults.temporaryBytes).toEqual([expect.any(Number)])
            expect(faults.temporaryBytes[0]).toBeGreaterThan(0)
            expect(faults.handles).toHaveLength(1)
            expect(faults.handles[0]!.fd).toBe(-1)
            expect(await store.load(0)).toEqual(snapshot)
            expect(await readdir(directory)).toEqual(["shard-0.json"])
            // The store is not left broken: The next save replaces the file
            faults[fault] = undefined
            await store.save(0, replacement)
            expect(await store.load(0)).toEqual(replacement)
            expect(await readdir(directory)).toEqual(["shard-0.json"])
        },
    )

    test("rejects an empty path or a URL that is not a file URL with ConfigurationError", () => {
        expect(() => fileSessionStore("")).toThrow(ConfigurationError)
        expect(() => fileSessionStore(new URL("https://example.com/sessions/"))).toThrow(ConfigurationError)
        expect(() => fileSessionStore(42 as never)).toThrow(ConfigurationError)
    })
})

/** Connect a test client that persists sessions in the directory, shut it down and return its gateway commands */
async function runOnce(mode: Mode, directory: string, clock: SdkClock, recoveryWaitMs?: number) {
    const sharding = {
        totalShards: 1,
        sessions: mode === "default" ? fileSessionStore(directory) : nativeFileSessionStore(directory),
    }
    // A session that Fluxer no longer holds is rejected, and the client identifies after its recovery wait
    const recover = async () => {
        if (recoveryWaitMs === undefined) return
        await clock.waiting(recoveryWaitMs)
        await clock.advance(recoveryWaitMs)
    }
    if (mode === "default") {
        const test = createDefaultTestClient({ sharding })
        const ready = test.ready()
        await recover()
        await ready
        await test.shutdown()
        return test.commands()
    }
    const scope = Scope.makeUnsafe()
    const test = await Effect.runPromise(createNativeTestClient({ sharding }).pipe(Scope.provide(scope)))
    const ready = Effect.runPromise(test.ready())
    await recover()
    await ready
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return test.commands()
}

describe.each(modes)("%s client with fileSessionStore", (mode) => {
    test("resumes the session it saved at shutdown after a restart", async () => {
        const clock = sdkClock()
        const directory = await temporaryDirectory()
        const first = await runOnce(mode, directory, clock)
        expect(first.map((command) => command.op)).toContain(2)
        const saved = JSON.parse(await readFile(join(directory, "shard-0.json"), "utf8")) as SessionSnapshot
        // With the jitter at 0.5, the first recovery waits 500 ms
        const second = await runOnce(mode, directory, clock, 500)
        // The restarted client first tries to resume the saved session. Its new test gateway never held that session,
        // so the client then identifies, as it would after Fluxer's retention window
        expect(second[0]).toMatchObject({ op: 6, d: { session_id: saved.sessionId } })
    })
})
