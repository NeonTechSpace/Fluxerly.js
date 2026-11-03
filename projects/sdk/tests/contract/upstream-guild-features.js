import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copiesPath, keepingCopies } from "../../../release/upstream.js"

// Read-only, opt-in source drift check, not provider deployment or runtime proof
// Pin one current revision before reading files so concurrent upstream commits cannot mix contracts
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

const guild = "fluxer_api/src/api/guild"

/**
 * Reads the guild files this check compares at the current upstream revision. The revision is read fresh. Each file comes
 * from the kept upstream copies when a fresh listing of its folder names bytes a copy has, and is downloaded otherwise.
 * The copies are shared with the drift check, so this never prunes them
 * @param {{ github?: (path: string) => any, copiesFolder?: string, stage?: (name: string) => void }} [options]
 */
export async function readGuildSources({ github = githubCli, copiesFolder = copiesPath, stage = () => {} } = {}) {
    stage("upstream_revision")
    const revision = github("commits/main").sha
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
    const source = async (path) =>
        (await kept.fetchFile("fluxerapp/fluxer", revision, `${guild}/${path}`)).toString("utf8")
    stage("toggleable_feature_set")
    const operations = await source("services/data/GuildOperationsService.ts")
    stage("emoji_source_opt_in")
    const emoji = await source("services/content/EmojiService.ts")
    stage("sticker_source_opt_in")
    const sticker = await source("services/content/StickerService.ts")
    return { revision, operations, services: { Emoji: emoji, Sticker: sticker } }
}

async function main() {
    let stage = "sdk_build"
    try {
        const { GuildFeatureToggles } = await import("../../dist/index.js")
        const { revision, operations, services } = await readGuildSources({ stage: (name) => (stage = name) })
        stage = "toggleable_feature_set"
        const declaration = operations.match(/const USER_TOGGLEABLE_GUILD_FEATURES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)
        assert.ok(declaration, "Upstream feature-set structure changed; inspect before updating the check")
        const entries = declaration[1]
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        const upstream = entries.map((entry) => {
            const match = entry.match(/^GuildFeatures\.([A-Z_]+)$/)
            assert.ok(match, "Upstream feature entry is no longer a direct constant")
            return match[1]
        })
        assert.deepEqual([...Object.values(GuildFeatureToggles)].sort(), upstream.sort())
        for (const [kind, flag] of [
            ["Emoji", GuildFeatureToggles.CloneEmojiEnabled],
            ["Sticker", GuildFeatureToggles.CloneStickerEnabled],
        ]) {
            stage = `${kind.toLowerCase()}_source_opt_in`
            // Upstream writes the missing-guild and missing-feature guard either with optional chaining or as two conditions
            const condition = new RegExp(
                `if\\s*\\(\\s*(?:!sourceGuild\\?\\.features|!sourceGuild\\s*\\|\\|\\s*!sourceGuild\\.features)\\.has\\(GuildFeatures\\.${flag}\\)\\s*\\)\\s*\\{\\s*throw new MissingAccessError\\(\\)`,
            )
            assert.match(services[kind], condition, "Upstream source-guild cloning guard changed; review its semantics")
        }
        console.log(
            JSON.stringify({ check: "upstream_guild_features", revision, passed: true, proof: "source_contract" }),
        )
    } catch {
        console.error(JSON.stringify({ check: "upstream_guild_features", stage, passed: false }))
        process.exitCode = 1
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
