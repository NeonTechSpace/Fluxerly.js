import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Cause, Effect, Exit, Scope, Stream } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")

const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
let lock
let client
let scope
let token
let guildId
let botId
let stage = "configuration"

const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))
const skip = (check, reason) => console.log(JSON.stringify({ mode, check, skipped: true, reason }))

function releaseLock() {
    if (lock === undefined) return
    closeSync(lock)
    lock = undefined
    unlinkSync(lockPath)
}

function safeFailure(error) {
    return {
        mode,
        check: stage,
        passed: false,
        tag: error?._tag ?? error?.name ?? "Error",
        ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    }
}

function sameStringSet(left, right) {
    return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        new Set(left).size === left.length &&
        new Set(right).size === right.length &&
        left.every((value) => right.includes(value))
    )
}

function rawPermissionCalculation(guild, member, roles, channel) {
    assert.ok(guild && typeof guild === "object")
    assert.ok(member && typeof member === "object")
    assert.ok(Array.isArray(roles))
    assert.ok(typeof guild.id === "string" && typeof guild.owner_id === "string")
    assert.ok(member.user && typeof member.user === "object" && typeof member.user.id === "string")
    assert.ok(Array.isArray(member.roles))

    const all = (1n << 64n) - 1n
    if (member.user.id === guild.owner_id) return all

    const permissions = new Map()
    for (const role of roles) {
        assert.ok(role && typeof role === "object")
        assert.ok(typeof role.id === "string" && typeof role.permissions === "string")
        assert.ok(/^(0|[1-9][0-9]{0,19})$/.test(role.permissions))
        assert.ok(!permissions.has(role.id))
        permissions.set(role.id, BigInt(role.permissions))
    }
    assert.ok(permissions.has(guild.id))

    let result = permissions.get(guild.id)
    for (const roleId of member.roles) {
        assert.ok(typeof roleId === "string" && permissions.has(roleId))
        result |= permissions.get(roleId)
    }
    if ((result & (1n << 3n)) === 1n << 3n) return all
    if (channel === undefined) return result

    assert.ok(channel && typeof channel === "object")
    assert.ok(channel.guild_id === guild.id && Array.isArray(channel.permission_overwrites))
    const apply = (allow, deny) => (result & ~BigInt(deny)) | BigInt(allow)
    for (const overwrite of channel.permission_overwrites) {
        assert.ok(overwrite && typeof overwrite === "object")
        assert.ok(
            typeof overwrite.id === "string" &&
                (overwrite.type === 0 || overwrite.type === 1) &&
                typeof overwrite.allow === "string" &&
                typeof overwrite.deny === "string" &&
                /^(0|[1-9][0-9]{0,19})$/.test(overwrite.allow) &&
                /^(0|[1-9][0-9]{0,19})$/.test(overwrite.deny),
        )
        if (overwrite.type === 0 && overwrite.id === guild.id) result = apply(overwrite.allow, overwrite.deny)
    }

    let roleAllow = 0n
    let roleDeny = 0n
    for (const overwrite of channel.permission_overwrites)
        if (overwrite.type === 0 && member.roles.includes(overwrite.id)) {
            roleAllow |= BigInt(overwrite.allow)
            roleDeny |= BigInt(overwrite.deny)
        }
    result = (result & ~roleDeny) | roleAllow
    for (const overwrite of channel.permission_overwrites)
        if (overwrite.type === 1 && overwrite.id === member.user.id) result = apply(overwrite.allow, overwrite.deny)
    return result
}

function samePermissionOverwrites(projected, raw) {
    return (
        Array.isArray(projected) &&
        Array.isArray(raw) &&
        projected.length === raw.length &&
        projected.every((overwrite) =>
            raw.some(
                (source) =>
                    source?.id === overwrite.id &&
                    source.type === (overwrite.type === "role" ? 0 : 1) &&
                    source.allow === overwrite.allow.toString() &&
                    source.deny === overwrite.deny.toString(),
            ),
        )
    )
}

function sameSearchHit(hit, raw) {
    return (
        hit &&
        raw &&
        hit.guildId === raw.guild_id &&
        hit.userId === raw.user_id &&
        hit.username === raw.username &&
        hit.discriminator === raw.discriminator &&
        hit.globalName === raw.global_name &&
        hit.nickname === raw.nickname &&
        sameStringSet(hit.roleIds, raw.role_ids) &&
        hit.joinedAtSeconds === raw.joined_at &&
        hit.isBot === raw.is_bot &&
        hit.joinSourceType === (raw.supplemental?.join_source_type ?? null) &&
        hit.sourceInviteCode === raw.supplemental?.source_invite_code &&
        hit.inviterId === raw.supplemental?.inviter_id
    )
}

function sameSearchPage(page, raw) {
    return (
        page &&
        raw &&
        page.guildId === raw.guild_id &&
        page.pageResultCount === raw.page_result_count &&
        page.totalResultCount === raw.total_result_count &&
        page.indexing === raw.indexing &&
        Array.isArray(raw.members) &&
        page.members.length === raw.members.length &&
        page.members.every((member, index) => sameSearchHit(member, raw.members[index]))
    )
}

async function value(operation) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

async function api(method, path, body) {
    let response
    try {
        response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok)
            throw Object.assign(new Error("Sandbox HTTP request failed"), {
                status: response.status,
            })
        return await response.json().catch(() => null)
    } finally {
        if (response && !response.bodyUsed) await response.body?.cancel()
    }
}

async function rawMemberSearch(body) {
    let response
    try {
        response = await rawFetch(`https://api.fluxer.app/v1/guilds/${guildId}/members-search`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
        if (!response.ok)
            throw Object.assign(new Error("Sandbox member search failed"), {
                status: response.status,
            })
        return await response.json().catch(() => null)
    } finally {
        if (response && !response.bodyUsed) await response.body?.cancel()
    }
}

async function waitForRawMemberSearch(body) {
    const deadline = performance.now() + 30_000
    let page
    do {
        page = await rawMemberSearch(body)
        if (page?.indexing !== true) return page
        await sleep(Math.min(2_000, Math.max(0, deadline - performance.now())))
    } while (performance.now() < deadline)
    return page
}

async function collectSearch(iterable) {
    const hits = []
    for await (const item of iterable) {
        if (item?.isErr?.()) throw item.error
        hits.push(item?.isOk?.() ? item.value : item)
    }
    return hits
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, check: stage, passed: false, reason: "deadline" }))
    try {
        releaseLock()
    } catch {
        // The process is terminating; do not mask the bounded-run failure with local cleanup details.
    }
    process.exit(1)
}, 90_000).unref()

try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))

    const env = { ...parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8")), ...process.env }
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.ok(/^[1-9][0-9]*$/.test(guildId ?? ""))
    assert.ok(/^[1-9][0-9]*$/.test(env.FLUXER_TEST_APPLICATION_ID ?? ""))
    assert.ok(token.split(".")[0] === env.FLUXER_TEST_APPLICATION_ID)

    stage = "sandbox_identity"
    const [application, self, rawGuild, rawMember, rawRoles] = await Promise.all([
        api("GET", "/applications/@me"),
        api("GET", "/users/@me"),
        api("GET", `/guilds/${guildId}`),
        api("GET", `/guilds/${guildId}/members/@me`),
        api("GET", `/guilds/${guildId}/roles`),
    ])
    assert.ok(application && application.id === env.FLUXER_TEST_APPLICATION_ID)
    assert.ok(self && self.bot === true && application.bot?.id === self.id)
    assert.ok(rawGuild && rawGuild.id === guildId)
    assert.ok(rawMember?.user?.id === self.id && Array.isArray(rawMember.roles))
    assert.ok(Array.isArray(rawRoles))
    botId = self.id
    report(stage)

    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    if (mode === "default") client = sdk.createClient({ token })._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    }

    stage = "permission_snapshots_and_independent_calculation"
    const [guild, member, roles] = await Promise.all([
        value(client.guilds.fetch(guildId)),
        value(client.members.fetchSelf(guildId)),
        value(client.roles.fetchAll(guildId)),
    ])
    assert.ok(guild.id === rawGuild.id && guild.ownerId === rawGuild.owner_id)
    assert.ok(member.guildId === guildId && member.userId === botId)
    assert.ok(sameStringSet(member.roleIds, rawMember.roles))
    assert.ok(
        roles.length === rawRoles.length &&
            roles.every((role) =>
                rawRoles.some(
                    (rawRole) => rawRole?.id === role.id && String(rawRole.permissions) === role.permissions.toString(),
                ),
            ),
    )
    assert.ok(Object.isFrozen(guild) && Object.isFrozen(member) && Object.isFrozen(member.roleIds))
    assert.ok(Object.isFrozen(roles) && roles.every(Object.isFrozen))

    const rawPermissions = rawPermissionCalculation(rawGuild, rawMember, rawRoles)
    const calculatedPermissions = await value(client.permissions.calculate({ guild, member, roles }))
    const fetchedPermissions = await value(client.permissions.fetch({ guildId, userId: botId }))
    assert.ok(calculatedPermissions === rawPermissions && fetchedPermissions === rawPermissions)
    report(stage, {
        layer: "guild_level_raw_permission_bitfield_from_current_guild_member_and_role_observations",
        channelOverwritesChecked: false,
    })

    stage = "channel_permission_snapshots_and_independent_calculation"
    const visibleChannels = await value(client.channels.fetchAll(guildId))
    if (visibleChannels.length === 0) {
        skip(stage, "no_visible_guild_channel")
    } else {
        const selectedChannel = visibleChannels[0]
        assert.ok(selectedChannel?.guildId === guildId)
        const [channel, rawChannel] = await Promise.all([
            value(client.channels.fetch(selectedChannel.id)),
            api("GET", `/channels/${selectedChannel.id}`),
        ])
        if (!Array.isArray(channel.permissionOverwrites) || !Array.isArray(rawChannel?.permission_overwrites)) {
            skip(stage, "visible_channel_omits_explicit_overwrite_snapshot")
        } else {
            assert.ok(channel.guildId === guildId && rawChannel.id === channel.id && rawChannel.guild_id === guildId)
            assert.ok(samePermissionOverwrites(channel.permissionOverwrites, rawChannel.permission_overwrites))
            assert.ok(Object.isFrozen(channel) && Object.isFrozen(channel.permissionOverwrites))
            assert.ok(channel.permissionOverwrites.every(Object.isFrozen))
            const rawChannelPermissions = rawPermissionCalculation(rawGuild, rawMember, rawRoles, rawChannel)
            const calculatedChannelPermissions = await value(
                client.permissions.calculate({ guild, member, roles, channel }),
            )
            const fetchedChannelPermissions = await value(
                client.permissions.fetch({ guildId, userId: botId, channelId: channel.id }),
            )
            assert.ok(
                calculatedChannelPermissions === rawChannelPermissions &&
                    fetchedChannelPermissions === rawChannelPermissions,
            )
            report(stage, {
                layer: "channel_scoped_raw_permission_bitfield_from_current_guild_member_role_and_overwrite_observations",
                channelOverwritesChecked: true,
                fullDenyPrecedenceNotProven: true,
            })
        }
    }

    // Fluxer may lazily build its member index for this authorized read-only POST. Reports intentionally omit request
    // bodies, identifiers, usernames, hits, counts and response bodies, so this manual harness never exposes member data.
    console.log(
        JSON.stringify({
            mode,
            notice: "member_search_provider_indexing_may_start",
            responseBodiesLogged: false,
        }),
    )
    const query = rawMember.user.username
    assert.ok(typeof query === "string" && query.length <= 100)
    const searchFilters = Object.freeze({ query, isBot: true, limit: 1, offset: 0 })
    const rawSearch = await waitForRawMemberSearch({ query, is_bot: true, limit: 1, offset: 0 })
    if (rawSearch?.indexing === true) {
        skip("member_search_raw_comparison", "provider_indexing")
    } else if (!Array.isArray(rawSearch?.members) || rawSearch.members.length === 0) {
        skip("member_search_filtered_bot_lookup", "provider_search_empty_or_unavailable")
    } else {
        stage = "member_search_raw_comparison"
        const searched = await value(client.members.search(guildId, searchFilters))
        if (searched.indexing) {
            skip(stage, "provider_indexing")
        } else {
            assert.ok(sameSearchPage(searched, rawSearch))
            assert.ok(
                Object.isFrozen(searched) &&
                    Object.isFrozen(searched.members) &&
                    searched.members.every((member) => Object.isFrozen(member) && Object.isFrozen(member.roleIds)),
            )

            const botHit = searched.members.find((member) => member.userId === botId)
            if (!botHit) {
                skip("member_search_filtered_bot_lookup", "provider_index_did_not_return_authenticated_bot")
            } else {
                stage = "member_search_filtered_bot_lookup"
                assert.ok(botHit.isBot === true)
                assert.ok(rawSearch.members.some((member) => member?.user_id === botId && member.is_bot === true))
                report("member_search_raw_comparison")
                const iterated = await collectSearch(
                    mode === "default"
                        ? client.members.iterateSearch(
                              guildId,
                              { query, isBot: true, offset: 0 },
                              { maxItems: 1, pageSize: 1, maxPages: 1 },
                          )
                        : Stream.toAsyncIterable(
                              client.members.iterateSearch(
                                  guildId,
                                  { query, isBot: true, offset: 0 },
                                  { maxItems: 1, pageSize: 1, maxPages: 1 },
                              ),
                          ),
                )
                assert.ok(iterated.length === 1 && iterated[0]?.userId === botId && iterated[0]?.isBot === true)
                report(stage)

                stage = "member_search_sensitive_filter_preflight"
                if (botHit.joinSourceType === null) {
                    skip(stage, "authenticated_bot_join_source_unavailable")
                } else {
                    const sensitive = await value(
                        client.members.search(guildId, {
                            ...searchFilters,
                            joinSourceTypes: [botHit.joinSourceType],
                        }),
                    )
                    const rawSensitive = await rawMemberSearch({
                        query,
                        is_bot: true,
                        limit: 1,
                        offset: 0,
                        join_source_type: [botHit.joinSourceType],
                    })
                    assert.ok(!sensitive.indexing && sameSearchPage(sensitive, rawSensitive))
                    assert.ok(
                        sensitive.members.some(
                            (hit) => hit.userId === botId && hit.joinSourceType === botHit.joinSourceType,
                        ),
                    )
                    report(stage)
                }

                stage = "member_search_injected_transport_failure_and_recovery"
                let attempts = 0
                globalThis.fetch = async (url, options) => {
                    const target = new URL(String(url))
                    if (
                        target.pathname === `/v1/guilds/${guildId}/members-search` &&
                        options?.method === "POST" &&
                        ++attempts === 1
                    )
                        throw Error("test-owned transport interruption")
                    return rawFetch(url, options)
                }
                let failure
                try {
                    await value(client.members.search(guildId, searchFilters, { timeoutMs: 5_000 }))
                } catch (error) {
                    failure = error
                } finally {
                    globalThis.fetch = rawFetch
                }
                assert.ok(
                    failure?._tag === "GuildOperationError" &&
                        failure.operation === "members.search" &&
                        failure.reason === "network" &&
                        failure.outcome === "unknown" &&
                        failure.status === null,
                )
                assert.equal(attempts, 1)

                const recoveredRawSearch = await waitForRawMemberSearch({ query, is_bot: true, limit: 1, offset: 0 })
                if (recoveredRawSearch?.indexing === true) {
                    skip(stage, "provider_indexing_during_recovery")
                } else if (!Array.isArray(recoveredRawSearch?.members) || recoveredRawSearch.members.length === 0) {
                    skip(stage, "provider_search_empty_or_unavailable_during_recovery")
                } else {
                    const recovered = await value(client.members.search(guildId, searchFilters))
                    if (recovered.indexing) {
                        skip(stage, "provider_indexing_during_recovery")
                    } else {
                        assert.ok(sameSearchPage(recovered, recoveredRawSearch))
                        assert.ok(
                            recovered.members.some((member) => member.userId === botId && member.isBot === true) &&
                                recoveredRawSearch.members.some(
                                    (member) => member?.user_id === botId && member.is_bot === true,
                                ),
                        )
                        report(stage)
                    }
                }

                stage = "member_search_cancellation_cleanup"
                let started
                const startedSearch = new Promise((resolve) => {
                    started = resolve
                })
                attempts = 0
                globalThis.fetch = (url, options) => {
                    const target = new URL(String(url))
                    if (target.pathname !== `/v1/guilds/${guildId}/members-search` || options?.method !== "POST")
                        return rawFetch(url, options)
                    attempts += 1
                    return new Promise((_, reject) => {
                        options.signal.addEventListener(
                            "abort",
                            () => reject(new DOMException("test-owned cancellation", "AbortError")),
                            { once: true },
                        )
                        started()
                    })
                }
                const controller = new AbortController()
                const cancelled =
                    mode === "default"
                        ? client.members.search(guildId, searchFilters, { timeoutMs: 5_000, signal: controller.signal })
                        : Effect.runPromiseExit(client.members.search(guildId, searchFilters, { timeoutMs: 5_000 }), {
                              signal: controller.signal,
                          })
                try {
                    await startedSearch
                    controller.abort()
                    const outcome = await cancelled
                    if (mode === "default") assert.ok(outcome?.isErr?.() && outcome.error?._tag === "CancelledError")
                    else assert.ok(Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
                    assert.equal(attempts, 1)
                } finally {
                    globalThis.fetch = rawFetch
                }
                report(stage)
            }
        }
    }
} catch (error) {
    console.error(JSON.stringify(safeFailure(error)))
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        console.error(
            JSON.stringify({
                mode,
                check: "client_cleanup",
                passed: false,
                finalizer,
                lockRetained: lock !== undefined,
            }),
        )
        process.exitCode = 1
    }
    if (client)
        try {
            const closed = client.shutdown()
            if (Effect.isEffect(closed)) await Effect.runPromise(closed)
            else await closed
        } catch {
            retainEvidence("client_shutdown")
        }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        } catch {
            retainEvidence("scope_close")
        }
    if (quiescent)
        try {
            releaseLock()
        } catch {
            retainEvidence("sandbox_lock_cleanup")
        }
    if (quiescent) clearTimeout(watchdog)
}
