// Opt-in hosted Fluxer protocol probe, not an SDK connection implementation
// Protocol: https://docs.fluxer.app/gateway/overview/
// Creates no journal and changes no server content: identity and gateway discovery reads, then one gateway session
// that identifies, heartbeats and closes cleanly
import { HarnessCheckError, acquireLock, loadSandboxEnvironment, verifySandboxIdentity } from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { anyStatus, createSandboxApi } from "./support/sandbox-api.js"

const report = createReporter({})

class ProbeFailure extends Error {
    constructor(check, details = {}) {
        super(check)
        this.check = check
        this.details = details
    }
}

async function get(path, token, check) {
    try {
        const api = createSandboxApi({ fetch, token: () => token, accept: anyStatus, timeoutMs: 10_000 })
        const { status, data } = await api("GET", path)
        if (status < 200 || status > 299) throw new ProbeFailure(check, { httpStatus: status })
        if (data === null) throw new ProbeFailure(check)
        return data
    } catch (error) {
        // Never print raw transport errors, bodies, URLs containing IDs or credentials
        throw error instanceof ProbeFailure ? error : new ProbeFailure(check)
    }
}

async function probeGateway(url, token, botId) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url)
        let heartbeatTimer
        let closeTimer
        let sequence = null
        let ready = false
        let closing = false
        let failure
        let pendingHeartbeat
        let acknowledgements = 0
        let scheduledAcknowledgements = 0
        let heartbeatIntervalMs
        const started = performance.now()

        const stop = (error) => {
            if (closing) return
            closing = true
            failure = error
            clearInterval(heartbeatTimer)
            clearTimeout(startupTimer)
            clearTimeout(totalTimer)
            closeTimer = setTimeout(() => {
                reject(new ProbeFailure("gateway_close_timeout", { cleanCloseVerified: false }))
            }, 5_000)
            try {
                socket.close(1000, "Sandbox probe finished")
            } catch {
                clearTimeout(closeTimer)
                reject(new ProbeFailure("gateway_close_request", { cleanCloseVerified: false }))
            }
        }
        const startupTimer = setTimeout(() => stop(new ProbeFailure("gateway_ready_timeout")), 30_000)
        const totalTimer = setTimeout(() => stop(new ProbeFailure("gateway_probe_timeout")), 90_000)

        const heartbeat = (scheduled) => {
            // A heartbeat still awaiting its acknowledgement also covers the scheduled tick that falls in that wait
            if (pendingHeartbeat && scheduled) pendingHeartbeat.scheduled = true
            if (closing || pendingHeartbeat || socket.readyState !== WebSocket.OPEN) return
            pendingHeartbeat = { scheduled }
            try {
                socket.send(JSON.stringify({ op: 1, d: sequence }))
            } catch {
                stop(new ProbeFailure("gateway_heartbeat_send"))
            }
        }

        socket.addEventListener("message", (event) => {
            if (closing) return
            try {
                if (typeof event.data !== "string") throw new ProbeFailure("gateway_frame_type")
                const payload = JSON.parse(event.data)
                if (payload.op === 10) {
                    if (heartbeatTimer) throw new ProbeFailure("gateway_duplicate_hello")
                    heartbeatIntervalMs = payload.d?.heartbeat_interval
                    if (
                        !Number.isInteger(heartbeatIntervalMs) ||
                        heartbeatIntervalMs <= 0 ||
                        heartbeatIntervalMs > 60_000
                    ) {
                        throw new ProbeFailure("gateway_interval_outside_probe_bounds")
                    }
                    heartbeatTimer = setInterval(() => heartbeat(true), heartbeatIntervalMs)
                    socket.send(
                        JSON.stringify({
                            op: 2,
                            d: {
                                token,
                                properties: {
                                    os: process.platform,
                                    browser: "Fluxerly sandbox probe",
                                    device: "Fluxerly sandbox probe",
                                },
                            },
                        }),
                    )
                    report("gateway_hello", { passed: true, heartbeatIntervalMs })
                } else if (payload.op === 0) {
                    if (!Number.isSafeInteger(payload.s) || payload.s < 0) throw new ProbeFailure("gateway_sequence")
                    if (payload.t === "READY") {
                        if (ready || payload.d?.user?.id !== botId || typeof payload.d?.session_id !== "string") {
                            throw new ProbeFailure("gateway_ready_identity")
                        }
                        ready = true
                        clearTimeout(startupTimer)
                        report("gateway_ready", { passed: true })
                    }
                    // The probe discards event bodies and retains only the processed sequence
                    sequence = payload.s
                    if (payload.t === "READY") heartbeat(false)
                } else if (payload.op === 1) {
                    heartbeat(false)
                } else if (payload.op === 11 && pendingHeartbeat) {
                    acknowledgements += 1
                    if (pendingHeartbeat.scheduled) scheduledAcknowledgements += 1
                    pendingHeartbeat = undefined
                    report("gateway_heartbeat_ack", { acknowledgements, scheduledAcknowledgements })
                    if (ready && acknowledgements >= 2 && scheduledAcknowledgements >= 1) stop()
                } else if (payload.op === 7 || payload.op === 9) {
                    throw new ProbeFailure("gateway_session_interrupted")
                }
            } catch (error) {
                stop(error instanceof ProbeFailure ? error : new ProbeFailure("gateway_payload"))
            }
        })
        socket.addEventListener("error", () => stop(new ProbeFailure("gateway_transport")))
        socket.addEventListener("close", (event) => {
            clearInterval(heartbeatTimer)
            clearTimeout(startupTimer)
            clearTimeout(totalTimer)
            clearTimeout(closeTimer)
            const cleanClose = closing && event.wasClean && event.code === 1000
            if (failure) reject(failure)
            else if (!cleanClose) reject(new ProbeFailure("gateway_close", { closeCode: event.code }))
            else
                resolve({
                    ready,
                    acknowledgements,
                    scheduledAcknowledgements,
                    heartbeatIntervalMs,
                    closeCode: event.code,
                    cleanClose: true,
                    elapsedMs: Math.round(performance.now() - started),
                })
        })
    })
}

let lock
let stage = "configuration"
try {
    const { guildId, applicationId, token } = loadSandboxEnvironment({ requireApplicationToken: true })

    stage = "sandbox_lock"
    lock = acquireLock()

    // Request failures keep their per-read check names; identity mismatches report the refused identity check
    const readChecks = { "/applications/@me": "application_identity", "/users/@me": "bot_identity" }
    const { user } = await verifySandboxIdentity((path) => get(path, token, readChecks[path] ?? "test_server_access"), {
        applicationId,
        guildId,
    })
    const gateway = await get("/gateway/bot", token, "gateway_discovery")
    stage = "gateway_endpoint"
    const url = new URL(gateway.url)
    if (url.protocol !== "wss:" || url.hostname !== "gateway.fluxer.app" || url.port || url.username || url.password) {
        throw new ProbeFailure(stage)
    }
    url.search = "?v=1&encoding=json"
    report("sandbox_identity", { passed: true, clientSecretUsed: false })
    stage = "gateway_probe"
    report("sandbox_protocol", { passed: true, ...(await probeGateway(url, token, user.id)) })
} catch (error) {
    report(error instanceof ProbeFailure || error instanceof HarnessCheckError ? error.check : stage, {
        passed: false,
        ...(error instanceof ProbeFailure ? error.details : {}),
    })
    process.exitCode = 1
} finally {
    if (lock !== undefined && !lock.release()) {
        report("sandbox_lock_cleanup", { passed: false, lockRetained: true })
        process.exitCode = 1
    }
}
// Bound failed runs even if an unresponsive transport did not complete its close
if (process.exitCode === 1) process.exit(1)
