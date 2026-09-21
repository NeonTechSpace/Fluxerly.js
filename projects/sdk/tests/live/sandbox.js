import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"

// Opt-in hosted Fluxer protocol probe, not an SDK connection implementation
// Protocol: https://docs.fluxer.app/gateway/overview/
const environment = new URL("../../.env.test.local", import.meta.url)
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ check, ...details }))

class ProbeFailure extends Error {
    constructor(check, details = {}) {
        super(check)
        this.check = check
        this.details = details
    }
}

async function get(path, token, check) {
    let response
    try {
        response = await fetch(`https://api.fluxer.app/v1${path}`, {
            headers: { Authorization: `Bot ${token}` },
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
        })
        if (!response.ok) {
            await response.body?.cancel()
            throw new ProbeFailure(check, { httpStatus: response.status })
        }
        return await response.json()
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
    const env = parseEnv(readFileSync(environment, "utf8"))
    const guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    const token = env.FLUXER_TEST_BOT_TOKEN
    if (!/^\d+$/.test(guildId ?? "") || !/^\d+$/.test(applicationId ?? "") || !token || token !== token.trim()) {
        throw new ProbeFailure("configuration")
    }
    if (token.split(".")[0] !== applicationId) throw new ProbeFailure("configured_application")

    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const application = await get("/applications/@me", token, "application_identity")
    if (application.id !== applicationId) throw new ProbeFailure("application_identity")
    const user = await get("/users/@me", token, "bot_identity")
    if (user.bot !== true || typeof user.id !== "string" || application.bot?.id !== user.id) {
        throw new ProbeFailure("bot_identity")
    }
    const guild = await get(`/guilds/${guildId}`, token, "test_server_access")
    if (guild.id !== guildId) throw new ProbeFailure("test_server_identity")
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
    report(error instanceof ProbeFailure ? error.check : stage, {
        passed: false,
        ...(error instanceof ProbeFailure ? error.details : {}),
    })
    process.exitCode = 1
} finally {
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
// Bound failed runs even if an unresponsive transport did not complete its close
if (process.exitCode === 1) process.exit(1)
