import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copiesPath, keepingCopies } from "../../../release/upstream.js"

// Read-only, opt-in source drift check, not provider deployment or runtime proof.
// Pin one upstream revision before reading files so concurrent commits cannot mix contracts
function githubCli(path) {
    return JSON.parse(
        execFileSync("gh", ["api", `repos/fluxerapp/fluxer/${path}`], {
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 2_000_000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        }),
    )
}

const manifestPath = fileURLToPath(new URL("../../../release/upstream/manifest.json", import.meta.url))
const gatewayRoot = "fluxer_gateway/src/fluxer_gateway"
const permCoreViewsPath = "fluxer_gateway/rust/crates/perm_core/src/views.rs"

const expectedPaths = {
    opcode: `${gatewayRoot}/gateway/opcode.gleam`,
    error: `${gatewayRoot}/core/error.gleam`,
    limits: `${gatewayRoot}/gateway/limits.gleam`,
    identify: `${gatewayRoot}/gateway/identify.gleam`,
    sharding: `${gatewayRoot}/gateway/sharding.gleam`,
    seed: `${gatewayRoot}/session/seed.gleam`,
    settings: `${gatewayRoot}/config/settings.gleam`,
    visibility: `${gatewayRoot}/guild/dispatch/visibility.gleam`,
    dispatch: `${gatewayRoot}/session/dispatch.gleam`,
    permViews: permCoreViewsPath,
}

/** Parse a Gleam integer or hexadecimal literal with optional underscore separators */
function parseGleamInt(raw) {
    const cleaned = raw.replaceAll("_", "")
    const value = cleaned.startsWith("0x") ? Number.parseInt(cleaned.slice(2), 16) : Number.parseInt(cleaned, 10)
    assert.ok(Number.isSafeInteger(value), `Invalid Gleam integer literal: ${raw}`)
    return value
}

/** Convert a Gleam PascalCase opcode variant name to the SDK's uppercase snake-case log name */
function expectedOpcodeName(variant) {
    if (variant === "LazyRequest") return "MEMBER_SUBSCRIPTIONS"
    return variant
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toUpperCase()
}

/** Extract a Gleam top-level function body from its signature line up to its closing brace */
function extractBlock(source, signaturePattern, label) {
    const match = source.match(signaturePattern)
    assert.ok(match, `Upstream ${label} structure changed: inspect before updating the check`)
    return match[1]
}

/** Extract a top-level Gleam integer constant */
function extractGleamConst(source, name) {
    const match = source.match(
        new RegExp(`^\\s*(?:pub\\s+)?const\\s+${name}\\s*=\\s*(0x[0-9a-fA-F_]+|[0-9_]+)\\s*$`, "m"),
    )
    assert.ok(match, `Upstream constant ${name} changed or moved: inspect before updating the check`)
    return parseGleamInt(match[1])
}

/** Extract a Gleam named duration field from config/settings.gleam */
function extractSettingsInt(source, field) {
    const match = source.match(new RegExp(`\\b${field}:\\s*([0-9_]+)\\s*,`))
    assert.ok(match, `Upstream setting ${field} changed or moved: inspect before updating the check`)
    return parseGleamInt(match[1])
}

/**
 * Reads the gateway Gleam and Rust files this check compares at either the pinned manifest commit or current main.
 * Each file comes from the kept upstream copies when a listing of its folder names bytes a copy has, and is downloaded
 * from GitHub otherwise. Never contacts Fluxer
 * @param {{ github?: (path: string) => any, copiesFolder?: string, pinned?: boolean, stage?: (name: string) => void }} [options]
 */
export async function readGatewaySources({
    github = githubCli,
    copiesFolder = copiesPath,
    pinned = false,
    stage = () => {},
} = {}) {
    stage("upstream_revision")
    const revision = pinned ? JSON.parse(readFileSync(manifestPath, "utf8")).commit : github("commits/main").sha
    assert.match(revision, /^[a-f0-9]{40}$/)
    const contents = {
        listDirectory: async (_repository, commit, directory) => {
            const entries = github(`contents/${directory}?ref=${commit}`)
            assert.ok(Array.isArray(entries), "Upstream folder listing is not a list")
            return entries.map(({ path, type, sha }) => ({
                path,
                type,
                ...(/^[a-f0-9]{40}$/.test(sha ?? "") ? { sha } : {}),
            }))
        },
        fetchFile: async (_repository, commit, path) => {
            const file = github(`contents/${path}?ref=${commit}`)
            assert.equal(file.encoding, "base64")
            return Buffer.from(file.content, "base64")
        },
    }
    const kept = keepingCopies(contents, copiesFolder)
    const files = {}
    for (const [key, path] of Object.entries(expectedPaths)) {
        stage(`fetch_${key}`)
        files[key] = (await kept.fetchFile("fluxerapp/fluxer", revision, path)).toString("utf8")
    }
    return { revision, pinned, files }
}

/** Compare parsed upstream gateway sources against built SDK constants */
export function verifyGatewaySources(files, sdk) {
    let stage = "opcodes"
    try {
        // 1. Opcodes: gateway/opcode.gleam
        const fromIntBody = extractBlock(
            files.opcode,
            /pub fn from_int\([^)]*\)\s*->\s*Opcode\s*\{([\s\S]*?)\n\}/,
            "opcode from_int",
        )
        const upstreamOpcodes = new Map()
        for (const match of fromIntBody.matchAll(/^\s*(\d+)\s*->\s*([A-Za-z0-9_]+)\s*$/gm)) {
            upstreamOpcodes.set(Number.parseInt(match[1], 10), match[2])
        }
        assert.ok(upstreamOpcodes.size > 0, "No upstream opcodes parsed from opcode.gleam")

        const toIntBody = extractBlock(
            files.opcode,
            /pub fn to_int\([^)]*\)\s*->\s*Result\(Int,\s*Nil\)\s*\{([\s\S]*?)\n\}/,
            "opcode to_int",
        )
        const reverseOpcodes = new Map()
        for (const match of toIntBody.matchAll(/^\s*([A-Za-z0-9_]+)\s*->\s*Ok\((\d+)\)\s*$/gm)) {
            reverseOpcodes.set(Number.parseInt(match[2], 10), match[1])
        }
        assert.deepEqual(
            [...upstreamOpcodes.entries()].sort((a, b) => a[0] - b[0]),
            [...reverseOpcodes.entries()].sort((a, b) => a[0] - b[0]),
        )

        // Opcode 28 (RequestForumUnreads) is intentionally named in opcodeName() without an Opcode constant
        const sdkOpcodeNumbers = [...new Set([...Object.values(sdk.Opcode), 28])].sort((a, b) => a - b)
        const upstreamOpcodeNumbers = [...upstreamOpcodes.keys()].sort((a, b) => a - b)
        assert.deepEqual(sdkOpcodeNumbers, upstreamOpcodeNumbers)
        for (const [code, variant] of upstreamOpcodes) {
            assert.equal(
                sdk.opcodeName(code),
                expectedOpcodeName(variant),
                `SDK opcodeName(${code}) disagrees with upstream ${variant}`,
            )
        }

        // 2. Close codes: core/error.gleam
        stage = "close_codes"
        const closeBody = extractBlock(
            files.error,
            /pub fn close_code_to_int\([^)]*\)\s*->\s*Int\s*\{([\s\S]*?)\n\}/,
            "close_code_to_int",
        )
        const upstreamCloseCodes = [...closeBody.matchAll(/^\s*[A-Za-z0-9_]+\s*->\s*(\d+)\s*$/gm)]
            .map((match) => Number.parseInt(match[1], 10))
            .sort((a, b) => a - b)
        assert.ok(upstreamCloseCodes.length > 0, "No upstream close codes parsed from error.gleam")
        const sdkCloseCodes = Object.values(sdk.CloseCode)
            .filter((code) => code >= 4000 && code < 5000)
            .sort((a, b) => a - b)
        assert.deepEqual(sdkCloseCodes, upstreamCloseCodes)

        // 3. Gateway limits, identify bounds, sharding bounds and session timings
        stage = "gateway_limits"
        const payloadLimitMatch = files.limits.match(/pub fn max_payload_size\(\)\s*->\s*Int\s*\{\s*([0-9_]+)\s*\}/)
        assert.ok(payloadLimitMatch, "Upstream max_payload_size structure changed")
        assert.equal(parseGleamInt(payloadLimitMatch[1]), sdk.maxClientPayloadBytes)

        assert.equal(extractGleamConst(files.identify, "max_token_bytes"), 256)
        assert.equal(extractGleamConst(files.identify, "max_ignored_events"), sdk.maxIgnoredEvents)
        assert.equal(
            extractGleamConst(files.identify, "flag_debounce_message_reactions"),
            sdk.IdentifyFlag.debounceMessageReactions,
        )

        assert.equal(extractGleamConst(files.sharding, "max_shard_count"), sdk.maximumShardCount)
        assert.equal(extractGleamConst(files.seed, "max_guilds_per_shard"), sdk.maxGuildsPerShard)

        assert.equal(extractSettingsInt(files.settings, "limits_heartbeat_interval_ms"), 41_250)
        assert.equal(extractSettingsInt(files.settings, "limits_heartbeat_timeout_ms"), 45_000)
        assert.equal(extractSettingsInt(files.settings, "limits_resume_timeout_ms"), sdk.sessionRetentionMs)

        // 4. Synthesized CHANNEL_DELETE payload fields: guild/dispatch/visibility.gleam
        stage = "visibility_channel_delete"
        const deletePayloadBody = extractBlock(
            files.visibility,
            /fn delete_payload\([^)]*\)\s*->\s*JsonTree\s*\{([\s\S]*?)\n\}/,
            "visibility delete_payload",
        )
        const objectBlock = deletePayloadBody.match(/json_tree\.Object\(\[([\s\S]*?)\]\)/)
        assert.ok(objectBlock, "Upstream delete_payload no longer builds json_tree.Object")
        const deleteFields = [...objectBlock[1].matchAll(/#\(\s*"([^"]+)"\s*,/g)].map((match) => match[1])
        assert.deepEqual(deleteFields, ["id", "guild_id"])

        // 5. Reaction debounce applies to every MESSAGE_REACTION_ADD when flag is set: session/dispatch.gleam
        stage = "debounce_reactions"
        assert.match(
            files.dispatch,
            /case\s+event,\s*state\.flags\.debounce_message_reactions,\s*facts\.detail\s*\{\s*"MESSAGE_REACTION_ADD",\s*True,\s*Reaction\(reaction\)\s*->\s*\{[\s\S]*?reactions\.hold\(/,
            "Upstream debounce_message_reactions handling changed: inspect session/dispatch.gleam",
        )

        // 6. Perm-core Owner and Administrator unknown-channel visibility: rust/crates/perm_core/src/views.rs
        stage = "perm_core_unknown_channel_visibility"
        const visibleBody = extractBlock(
            files.permViews,
            /pub fn visible\(&self,\s*user:\s*UserId,\s*channel:\s*ChannelId\)\s*->\s*Visible\s*\{([\s\S]*?)\n    \}/,
            "perm_core visible",
        )
        assert.match(visibleBody, /Who::Owner\s*\{\s*\.\.\s*\}\s*=>\s*Visible::all\(\)/)
        assert.match(visibleBody, /crate::rolesets::Base::All\s*=>\s*Visible::all\(\)/)
        assert.match(visibleBody, /crate::rolesets::Base::Bits\(_\)\s*=>\s*Visible::empty\(\)/)
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        failure.stage = stage
        throw failure
    }
}

async function main() {
    const pinned = process.argv.includes("--pinned")
    let stage = "sdk_build"
    try {
        const gateway = await import("../../dist/internal/protocol/gateway.js")
        const sharding = await import("../../dist/internal/sharding.js")
        const sdk = {
            Opcode: gateway.Opcode,
            opcodeName: gateway.opcodeName,
            CloseCode: gateway.CloseCode,
            IdentifyFlag: gateway.IdentifyFlag,
            maxClientPayloadBytes: gateway.maxClientPayloadBytes,
            maxIgnoredEvents: gateway.maxIgnoredEvents,
            maxGuildsPerShard: gateway.maxGuildsPerShard,
            sessionRetentionMs: gateway.sessionRetentionMs,
            maximumShardCount: sharding.maximumShardCount,
        }
        const { revision, files } = await readGatewaySources({ pinned, stage: (name) => (stage = name) })
        verifyGatewaySources(files, sdk)
        console.log(
            JSON.stringify({ check: "upstream_gateway", revision, pinned, passed: true, proof: "source_contract" }),
        )
    } catch (error) {
        const failedStage = error && typeof error === "object" && "stage" in error ? error.stage : stage
        const detail = error instanceof Error ? error.message : "Gateway source contract check failed"
        console.error(JSON.stringify({ check: "upstream_gateway", stage: failedStage, detail, passed: false }))
        process.exitCode = 1
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
