// Fluxer's gateway admits at most 12 member requests from one bot in any 10 seconds and drops the rest without a
// reply (fluxer_gateway/src/guild/guild_request_members_filter.erl), so an extra request only ends in a timeout.
// The default and Effect runs of a check, and checks that run at the same time, are separate processes, so the send
// times are kept in a Git-ignored file in the SDK directory, and each request waits until it fits the window
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { stateRoot } from "./state-root.js"

export const memberRequestLimit = 12
export const memberRequestWindowMs = 10_000
// Fluxer counts arrival times, so this covers a difference in network delay between two requests
const arrivalMarginMs = 1_000
/** The longest a single reservation can wait */
export const memberRequestMaxWaitMs = memberRequestWindowMs + arrivalMarginMs

const defaultPath = new URL(".env.test.local.member-requests.json", stateRoot)
// The record lock is held only for one synchronous read and write, so a lock that stays this many retries was left by
// a stopped process
const lockRetryMs = 10
const lockAttempts = 500

function readTimes(path) {
    let text
    try {
        text = readFileSync(path, "utf8")
    } catch (error) {
        if (error?.code === "ENOENT") return []
        throw error
    }
    const times = JSON.parse(text)
    if (!Array.isArray(times) || !times.every(Number.isSafeInteger)) throw new Error("Malformed member request record")
    return times
}

/**
 * Create a function that waits until one more member request fits Fluxer's window and records it as sent.
 * Call it directly before each request. Every check that requests members shares this file, so a lock file keeps one
 * writer at a time
 */
export function createMemberRequestPacing({ path = defaultPath, now = Date.now, wait = sleep } = {}) {
    const lockPath = `${path instanceof URL ? fileURLToPath(path) : path}.lock`
    async function locked(operation) {
        for (let attempt = 1; ; attempt++) {
            try {
                closeSync(openSync(lockPath, "wx"))
                break
            } catch (error) {
                if (error?.code !== "EEXIST") throw error
                if (attempt === lockAttempts)
                    throw new Error(`Member request record lock held too long. Remove ${lockPath} once no check runs`)
                await wait(lockRetryMs)
            }
        }
        try {
            return operation()
        } finally {
            rmSync(lockPath)
        }
    }
    return async function reserve() {
        for (;;) {
            // The time until the window has room, or undefined once this request is recorded
            const delay = await locked(() => {
                const current = now()
                const recent = readTimes(path)
                    .filter((time) => current - time < memberRequestMaxWaitMs)
                    .sort((a, b) => a - b)
                if (recent.length < memberRequestLimit) {
                    writeFileSync(path, JSON.stringify([...recent, current]))
                    return undefined
                }
                // The oldest request that keeps the window full leaves it at this time
                return recent[recent.length - memberRequestLimit] + memberRequestMaxWaitMs - current
            })
            if (delay === undefined) return
            await wait(delay)
        }
    }
}
