import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"

const mode = process.argv[2]
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.text-validation.local", import.meta.url)
const idPattern = /^[1-9][0-9]*$/
const markerPattern = /^fluxerly-tv-[a-f0-9]{32}$/
const report = (check, passed = true, details = {}) => console.log(JSON.stringify({ mode, check, passed, ...details }))
let stage = "configuration"
let lock, token, guildId, botId, journal, client, scope, Effect, Exit, Scope
let identityVerified = false

function boundaryName(marker, resource, finalAscii) {
    const prefix = `${marker}-${resource}-`
    const remaining = 100 - prefix.length
    assert.ok(remaining > 0)
    const name = prefix + (remaining % 2 === 1 ? finalAscii : "") + "🧪".repeat(Math.floor(remaining / 2))
    assert.equal(name.length, 100)
    assert.ok(name.includes(marker))
    return name
}

async function api(method, path, body, allowNotFound = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
                Authorization: `Bot ${token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data =
            response.status === 204 ? (await response.body?.cancel(), null) : await response.json().catch(() => null)
        if (response.status === 429 && attempt < 2) {
            const retryAfterMs =
                Math.max(Number(response.headers.get("retry-after")) || 0, Number(data?.retry_after) || 0) * 1_000
            assert.ok(Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= 10_000)
            await sleep(retryAfterMs)
            continue
        }
        if (!response.ok && !(allowNotFound && response.status === 404))
            throw Object.assign(new Error("Sandbox HTTP request failed"), { status: response.status })
        return { status: response.status, data }
    }
    throw new Error("Sandbox HTTP request budget exhausted")
}

async function value(operation) {
    if (mode === "default") {
        const result = await operation
        if (result.isErr()) throw result.error
        return result.value
    }
    const result = await Effect.runPromise(Effect.result(operation))
    if (result._tag === "Failure") throw result.failure
    return result.success
}

async function failure(operation) {
    try {
        await value(operation)
    } catch (error) {
        return error
    }
    assert.fail("Expected operation failure")
}

function assertLocalFailure(error, tag) {
    assert.equal(error?._tag, tag)
    assert.equal(error.reason, "input")
    assert.equal(error.outcome, "notDispatched")
}

function assertUnknownFailure(error, tag) {
    assert.equal(error?._tag, tag)
    assert.equal(error.reason, "network")
    assert.equal(error.outcome, "unknown")
}

async function observeWrite(method, path, expectedName, operation, loseSuccessfulResponse = false) {
    let attempts = 0
    let successfulDispatches = 0
    globalThis.fetch = async (request, options) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
        if (options?.method !== method || url.pathname !== `/v1${path}`) return rawFetch(request, options)
        attempts++
        assert.equal(JSON.parse(String(options.body)).name, expectedName)
        const response = await rawFetch(request, options)
        if (!response.ok) return response
        successfulDispatches++
        if (!loseSuccessfulResponse) return response
        await response.body?.cancel()
        throw new TypeError("Intentionally lost text-validation response")
    }
    try {
        return await operation()
    } finally {
        globalThis.fetch = rawFetch
        assert.ok(attempts >= 1 && attempts <= 3)
        assert.equal(successfulDispatches, 1)
    }
}

const save = () => writeFileSync(journalPath, JSON.stringify(journal))

function validateJournalRole(resource) {
    assert.ok(resource && typeof resource === "object")
    assert.equal(resource.kind, "role")
    assert.equal(resource.createAttempted, true)
    assert.ok(Array.isArray(resource.names) && resource.names.length === 2)
    for (const name of resource.names) {
        assert.equal(typeof name, "string")
        assert.equal(name.length, 100)
        assert.ok(name.includes(journal.marker))
    }
    if (resource.id !== undefined) assert.match(resource.id, idPattern)
}

async function cleanup() {
    if (!identityVerified || !journal) return
    assert.equal(journal.kind, "text-validation")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker ?? "", markerPattern)
    validateJournalRole(journal.role)

    stage = "resource_cleanup"
    const roles = (await api("GET", `/guilds/${guildId}/roles`)).data
    assert.ok(Array.isArray(roles))
    const roleMatches = roles.filter((role) => role.id === journal.role.id || journal.role.names.includes(role.name))
    assert.ok(roleMatches.length <= 1, "Ambiguous test-role marker; retain recovery journal")
    for (const role of roleMatches) {
        assert.notEqual(role.id, guildId)
        assert.equal(String(role.permissions), "0")
        assert.ok(journal.role.names.includes(role.name))
        if (journal.role.id !== undefined) assert.equal(role.id, journal.role.id)
        journal.role.id = role.id
        save()
        await api("DELETE", `/guilds/${guildId}/roles/${role.id}`)
    }

    const remainingRoles = await api("GET", `/guilds/${guildId}/roles`)
    assert.ok(
        !remainingRoles.data.some((role) => role.id === journal.role.id || journal.role.names.includes(role.name)),
    )
    unlinkSync(journalPath)
    journal = undefined
    report("test_role_removed", true, { roleAbsent: true })
}

const watchdog = setTimeout(() => {
    report(stage, false, { reason: "deadline", journalRetained: journal !== undefined, cleanupVerified: false })
    process.exit(1)
}, 180_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", idPattern)
    assert.match(applicationId ?? "", idPattern)

    stage = "sandbox_identity"
    const [application, bot, guild] = await Promise.all([
        api("GET", "/oauth2/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
    ])
    assert.equal(application.data?.id, applicationId)
    assert.equal(application.data?.bot?.id, bot.data?.id)
    assert.equal(bot.data?.bot, true)
    assert.match(bot.data?.id ?? "", idPattern)
    assert.equal(guild.data?.id, guildId)
    botId = bot.data.id
    identityVerified = true
    report(stage, true, { clientSecretUsed: false })

    stage = "recover_prior_test"
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }

    const marker = `fluxerly-tv-${randomUUID().replaceAll("-", "")}`
    const roleNames = [boundaryName(marker, "r", "x"), boundaryName(marker, "r", "y")]
    assert.notEqual(roleNames[0], roleNames[1])
    journal = {
        kind: "text-validation",
        guildId,
        botId,
        marker,
        role: { kind: "role", createAttempted: true, names: roleNames },
    }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })

    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    if (mode === "effect") {
        ;({ Effect, Exit, Scope } = await import("effect"))
        scope = Scope.makeUnsafe()
        client = await value(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    } else client = await value(sdk.createClient({ token }))

    stage = "role_local_rejection_and_recovery"
    let unexpectedDispatches = 0
    globalThis.fetch = async () => {
        unexpectedDispatches++
        throw new Error("Invalid role input dispatched unexpectedly")
    }
    try {
        assertLocalFailure(await failure(client.roles.create(guildId, { name: " \f\u202e " })), "GuildOperationError")
        assertLocalFailure(
            await failure(client.roles.create(guildId, { name: roleNames[0] + "🧪" })),
            "GuildOperationError",
        )
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(unexpectedDispatches, 0)
    const paddedRoleName = `  ${roleNames[0]}  `
    const createdRole = await observeWrite("POST", `/guilds/${guildId}/roles`, paddedRoleName, () =>
        value(client.roles.create(guildId, { name: paddedRoleName })),
    )
    assert.equal(createdRole.name, roleNames[0])
    assert.equal(createdRole.permissions, 0n)
    journal.role.id = createdRole.id
    save()
    report(stage, true, { invalidDispatches: 0, normalizedUnits: createdRole.name.length, originalWirePreserved: true })

    stage = "role_unknown_response_recovery"
    const controlledRoleName = `\f${roleNames[1]}\u202e`
    const roleFailure = await observeWrite(
        "PATCH",
        `/guilds/${guildId}/roles/${journal.role.id}`,
        controlledRoleName,
        () => failure(client.roles.edit({ guildId, id: journal.role.id }, { name: controlledRoleName })),
        true,
    )
    assertUnknownFailure(roleFailure, "GuildOperationError")
    const recoveredRole = (await api("GET", `/guilds/${guildId}/roles`)).data.find(
        (role) => role.id === journal.role.id,
    )
    assert.equal(recoveredRole?.name, roleNames[1])
    assert.equal(String(recoveredRole?.permissions), "0")
    report(stage, true, {
        reconciled: true,
        normalizedUnits: recoveredRole.name.length,
        singleSuccessfulDispatch: true,
    })

    stage = "client_shutdown"
    await value(client.shutdown())
    assert.equal(client.state, "Closed")
    report(stage)
    await cleanup()
} catch {
    report(stage, false, { journalRetained: journal !== undefined })
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    let quiescent = true
    if (client && client.state !== "Closed")
        try {
            await value(client.shutdown())
            assert.equal(client.state, "Closed")
            report("client_cleanup")
        } catch {
            quiescent = false
            report("client_cleanup", false, { journalRetained: journal !== undefined })
            process.exitCode = 1
        }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        } catch {
            quiescent = false
            report("scope_cleanup", false, { journalRetained: journal !== undefined })
            process.exitCode = 1
        }
    if (quiescent && identityVerified && journal)
        try {
            await cleanup()
        } catch {
            quiescent = false
            report("resource_cleanup", false, { journalRetained: true })
            process.exitCode = 1
        }
    if (quiescent && lock !== undefined)
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            quiescent = false
            report("lock_cleanup", false, { lockRetained: true })
            process.exitCode = 1
        }
    if (quiescent) clearTimeout(watchdog)
}
