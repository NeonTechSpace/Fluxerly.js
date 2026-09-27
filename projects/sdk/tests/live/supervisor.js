// Process supervisor child assignments, gateway connections and shutdown through an owned loopback proof endpoint.
// Creates no journal and no remote resources; the sandbox reads and child gateway sessions are read-only
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { acquireLock, finalizeOwned, loadSandboxEnvironment, verifySandboxIdentity } from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"

const mode = process.argv[2]
const totalShards = 2
const report = createReporter({ mode })
let stage = "configuration"
let lock
let proofServer
let supervisor
let supervisorClosed = false
let nativeEffect

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
    return Object.keys(value).sort().join("|") === [...keys].sort().join("|")
}

function validProof(value, secret) {
    if (!isRecord(value) || value.secret !== secret || value.mode !== mode) return false
    if (!Number.isSafeInteger(value.shardId) || value.shardId < 0 || value.shardId >= totalShards) return false
    if (value.kind === "connected")
        return (
            hasExactKeys(value, ["kind", "mode", "secret", "shardId", "state", "userId"]) &&
            value.state === "Connected" &&
            typeof value.userId === "string" &&
            /^[1-9][0-9]*$/.test(value.userId)
        )
    if (value.kind === "configured") return hasExactKeys(value, ["kind", "mode", "secret", "shardId"])
    return (
        (value.kind === "closed" &&
            hasExactKeys(value, ["kind", "mode", "secret", "shardId", "state"]) &&
            value.state === "Closed") ||
        (value.kind === "failed" && hasExactKeys(value, ["kind", "mode", "secret", "shardId"]))
    )
}

function openProofServer(secret) {
    const proofs = []
    const sockets = new Set()
    const server = createServer((request, response) => {
        if (
            request.method !== "POST" ||
            request.url !== "/proof" ||
            !request.socket.remoteAddress?.includes("127.0.0.1")
        ) {
            response.writeHead(404).end()
            return
        }

        let bytes = 0
        const chunks = []
        request.on("data", (chunk) => {
            bytes += chunk.length
            if (bytes <= 2_048) chunks.push(chunk)
        })
        request.on("end", () => {
            if (bytes > 2_048) {
                response.writeHead(413).end()
                return
            }
            let candidate
            try {
                candidate = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            } catch {
                response.writeHead(400).end()
                return
            }
            if (!validProof(candidate, secret)) {
                response.writeHead(400).end()
                return
            }
            proofs.push(Object.freeze(candidate))
            response.writeHead(204).end()
        })
        request.on("error", () => {
            if (!response.writableEnded) response.writeHead(400).end()
        })
    })
    server.on("connection", (socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
    })

    return {
        async open() {
            await new Promise((resolve, reject) => {
                server.once("error", reject)
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject)
                    resolve()
                })
            })
            const address = server.address()
            assert.ok(address && typeof address === "object")
            return `http://127.0.0.1:${address.port}/proof`
        },
        proofs: () => proofs.slice(),
        async close() {
            for (const socket of sockets) socket.destroy()
            await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
            assert.equal(sockets.size, 0)
        },
    }
}

const api = (path, token) => readSandbox(path, token, { timeout: 10_000 })

async function preflight(token, applicationId, guildId) {
    const { botId } = await verifySandboxIdentity((path) => api(path, token), {
        applicationId,
        guildId,
        applicationPath: "/oauth2/applications/@me",
        concurrent: true,
    })
    const member = await api(`/guilds/${guildId}/members/${botId}`, token)
    assert.equal(member.user?.id, botId)
    return botId
}

async function callSupervisor(operation, Effect) {
    if (mode === "default") {
        const result = await operation()
        assert.ok(result.isOk())
        return result.value
    }
    return Effect.runPromise(operation())
}

async function createSupervisor(sdk, Effect, options, token) {
    const previousToken = process.env.FLUXER_TEST_BOT_TOKEN
    // Keep the credential only in the inherited child snapshot; childEnvironment carries proof configuration
    process.env.FLUXER_TEST_BOT_TOKEN = token
    try {
        if (mode === "default") return sdk.supervisor.create(options)
        return await Effect.runPromise(sdk.supervisor.create(options))
    } finally {
        if (previousToken === undefined) delete process.env.FLUXER_TEST_BOT_TOKEN
        else process.env.FLUXER_TEST_BOT_TOKEN = previousToken
    }
}

function expectedAssignment(id) {
    return { totalShards, shardIds: [id] }
}

function assertRunningStatus() {
    const status = supervisor.status()
    assert.equal(status.state, "running")
    assert.equal(status.children.length, totalShards)
    const children = [...status.children].sort((left, right) => left.id.localeCompare(right.id))
    const pids = []
    for (const [shardId, child] of children.entries()) {
        assert.equal(child.id, `supervisor-live-${shardId}`)
        assert.deepEqual(child.assignment, expectedAssignment(shardId))
        assert.equal(child.state, "running")
        assert.equal(child.restarts, 0)
        assert.ok(Number.isSafeInteger(child.generation) && child.generation >= 0)
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
        pids.push(child.pid)
    }
    assert.equal(new Set(pids).size, totalShards)
    return pids
}

function assertClosedStatus() {
    const status = supervisor.status()
    assert.equal(status.state, "closed")
    assert.equal(status.children.length, totalShards)
    for (const [shardId, child] of [...status.children]
        .sort((left, right) => left.id.localeCompare(right.id))
        .entries()) {
        assert.equal(child.id, `supervisor-live-${shardId}`)
        assert.deepEqual(child.assignment, expectedAssignment(shardId))
        assert.equal(child.state, "closed")
        assert.equal(child.pid, null)
        assert.equal(child.connectionState, null)
    }
}

function assertConfiguredProofs() {
    const configured = proofServer.proofs().filter((proof) => proof.kind === "configured")
    assert.equal(configured.length, totalShards)
    assert.deepEqual(
        configured.map((proof) => proof.shardId).sort((left, right) => left - right),
        [0, 1],
    )
}

async function waitForConnected(botId) {
    const deadline = performance.now() + 50_000
    for (;;) {
        const proofs = proofServer.proofs()
        assert.equal(proofs.filter((proof) => proof.kind === "failed").length, 0)
        assert.equal(proofs.filter((proof) => proof.kind === "closed").length, 0)
        const connected = proofs.filter((proof) => proof.kind === "connected")
        if (connected.length === totalShards) {
            assert.deepEqual(
                connected.map((proof) => proof.shardId).sort((left, right) => left - right),
                [0, 1],
            )
            assert.ok(connected.every((proof) => proof.state === "Connected" && proof.userId === botId))
            return
        }
        assert.ok(performance.now() < deadline, "Timed out waiting for child connection proofs")
        await sleep(25)
    }
}

function assertClosedProofs() {
    const closed = proofServer.proofs().filter((proof) => proof.kind === "closed")
    assert.equal(closed.length, totalShards)
    assert.deepEqual(
        closed.map((proof) => proof.shardId).sort((left, right) => left - right),
        [0, 1],
    )
    assert.ok(closed.every((proof) => proof.state === "Closed"))
}

async function verifyExited(pids) {
    const deadline = performance.now() + 5_000
    let running = pids
    do {
        running = running.filter((pid) => {
            try {
                process.kill(pid, 0)
                return true
            } catch (error) {
                if (error?.code === "ESRCH") return false
                throw error
            }
        })
        if (running.length === 0) return
        await sleep(25)
    } while (performance.now() < deadline)
    assert.equal(running.length, 0, "Child process exit was not observed")
}

async function shutdown(Effect) {
    if (!supervisor) {
        supervisorClosed = true
        return
    }
    if (supervisorClosed) return
    const terminal = callSupervisor(() => supervisor.waitForClose(), Effect).then(
        () => true,
        () => false,
    )
    await callSupervisor(() => supervisor.shutdown(), Effect)
    supervisorClosed = true
    assert.equal(await terminal, true)
}

const watchdog = setTimeout(() => {
    report(stage, { passed: false, category: "process_timeout", containmentOnly: true })
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "configuration"
    const { token, applicationId, guildId } = loadSandboxEnvironment()

    stage = "sandbox_identity"
    const botId = await preflight(token, applicationId, guildId)
    report(stage, { passed: true, clientSecretUsed: false, serverMutations: false })

    const proofSecret = randomBytes(32).toString("base64url")
    proofServer = openProofServer(proofSecret)
    const proofUrl = await proofServer.open()
    const [sdk, effect] = await Promise.all([
        import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect"),
        mode === "effect" ? import("effect") : undefined,
    ])
    nativeEffect = effect?.Effect
    supervisor = await createSupervisor(
        sdk,
        nativeEffect,
        {
            entry: new URL("./supervisor-child.js", import.meta.url),
            totalShards,
            assignments: [
                { id: "supervisor-live-0", shardIds: [0] },
                { id: "supervisor-live-1", shardIds: [1] },
            ],
            childEnvironment: {
                FLUXERLY_SUPERVISOR_LIVE_MODE: mode,
                FLUXERLY_SUPERVISOR_LIVE_PROOF_URL: proofUrl,
                FLUXERLY_SUPERVISOR_LIVE_PROOF_SECRET: proofSecret,
            },
            identify: { minimumSpacingMs: 5_000 },
            startupTimeoutMs: 20_000,
            shutdownTimeoutMs: 20_000,
        },
        token,
    )

    stage = "assignment_configuration"
    await callSupervisor(() => supervisor.start(), nativeEffect)
    const pids = assertRunningStatus()
    assertConfiguredProofs()
    report(stage, {
        passed: true,
        assignments: totalShards,
        childPidsPresent: true,
        gatewayProofAwaitedSeparately: true,
    })

    stage = "child_connections"
    await callSupervisor(() => supervisor.waitForReady(), nativeEffect)
    assert.ok(supervisor.status().children.every((child) => child.connectionState === "Connected"))
    await waitForConnected(botId)
    report(stage, { passed: true, clients: totalShards, freshSelfReads: totalShards })

    stage = "supervisor_shutdown"
    await shutdown(nativeEffect)
    assertClosedStatus()
    assertClosedProofs()
    await verifyExited(pids)
    report(stage, { passed: true, childClosedReports: totalShards, childExitObserved: true })
} catch {
    const proofs = proofServer?.proofs() ?? []
    report(stage, {
        passed: false,
        category: "assertion_or_operation",
        proofs: Object.fromEntries(
            ["configured", "connected", "closed", "failed"].map((kind) => [
                kind,
                proofs.filter((proof) => proof.kind === kind).length,
            ]),
        ),
        childStates: supervisor?.status().children.map((child) => child.state),
    })
    process.exitCode = 1
} finally {
    // The lock and deadline stay unless both the supervisor and the proof server are proven closed
    const failures = []
    await finalizeOwned({
        writers: [
            ["supervisor_shutdown", () => shutdown(nativeEffect)],
            proofServer && ["proof_server_close", () => proofServer.close()],
        ],
        lock,
        watchdog,
        onFailure: (finalizer) => failures.push(finalizer),
    })
    if (failures.length) {
        report("cleanup", { passed: false, failures, lockRetained: lock?.held ?? false })
        process.exitCode = 1
    }
}
