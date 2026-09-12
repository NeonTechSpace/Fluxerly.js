import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { GuildFeatureToggles } from "../dist/index.js"

// Read-only, opt-in source drift check, not provider deployment or runtime proof
// Pin one current revision before reading files so concurrent upstream commits cannot mix contracts
function github(path) {
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

let stage = "upstream_revision"
try {
    const revision = github("commits/main").sha
    assert.match(revision, /^[a-f0-9]{40}$/)
    const source = (path) => {
        const file = github(`contents/fluxer_api/src/api/guild/${path}?ref=${revision}`)
        assert.equal(file.encoding, "base64")
        return Buffer.from(file.content, "base64").toString("utf8")
    }
    stage = "toggleable_feature_set"
    const operations = source("services/data/GuildOperationsService.ts")
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
        const service = source(`services/content/${kind}Service.ts`)
        const condition = new RegExp(
            `if\\s*\\(\\s*!sourceGuild\\s*\\|\\|\\s*!sourceGuild\\.features\\.has\\(GuildFeatures\\.${flag}\\)\\s*\\)\\s*\\{\\s*throw new MissingAccessError\\(\\)`,
        )
        assert.match(service, condition, "Upstream source-guild cloning guard changed; review its semantics")
    }
    console.log(JSON.stringify({ check: "upstream_guild_features", revision, passed: true, proof: "source_contract" }))
} catch {
    console.error(JSON.stringify({ check: "upstream_guild_features", stage, passed: false }))
    process.exitCode = 1
}
