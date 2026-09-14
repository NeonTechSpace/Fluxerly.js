import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "./content.mjs"
import { parseVersion, planVersion } from "./planning.mjs"

export async function readSourcePlan(workspace, options) {
    const [{ assembleReleasePlan }, { readChangesets }, { getPackages }, { readConfig }] = await Promise.all([
        import("@changesets/assemble-release-plan"),
        import("@changesets/read"),
        import("@manypkg/get-packages"),
        import("@changesets/config"),
    ])
    const packages = await getPackages(workspace)
    if (packages.rootDir !== workspace) throw new Error("Release commands must target the projects workspace")
    const sdk = packages.packages.find((item) => item.packageJson.name === "@neontechspace/fluxerly")
    if (!sdk || sdk.dir !== join(workspace, "sdk")) throw new Error("SDK package identity or location does not match")
    if (sdk.packageJson.private !== true)
        throw new Error("The canonical SDK source must retain its private publication safeguard")
    const configResult = await readConfig(workspace, packages)
    if (!configResult.config) throw new Error("Changesets configuration is invalid")
    const fragments = await readChangesets(workspace)
    for (const fragment of fragments) {
        if (fragment.releases.length !== 1 || fragment.releases[0].name !== sdk.packageJson.name)
            throw new Error("Release fragments must describe only the SDK package")
    }
    const pending = fragments.filter((fragment) => !fragment.id.startsWith("pre/"))
    const current = parseVersion(sdk.packageJson.version)
    await assertSourceReleaseState(workspace, current, fragments)
    const preState =
        options.channel === "stable"
            ? current.channel === "stable"
                ? undefined
                : { mode: "exit", tag: current.channel }
            : { mode: "pre", tag: options.channel }
    const releasePlan = assembleReleasePlan(fragments, packages, configResult.config, preState)
    if (releasePlan.releases.some((release) => release.name !== sdk.packageJson.name))
        throw new Error("Changesets attempted to release a non-SDK package")
    const proposal = releasePlan.releases.find((release) => release.name === sdk.packageJson.name)
    const plan = planVersion({
        currentVersion: sdk.packageJson.version,
        channel: options.channel,
        epoch: options.epoch,
        pendingTypes: pending.map((fragment) => fragment.releases[0].type),
        proposedVersion: proposal?.newVersion,
        allowNoChanges: options.allowNoChanges ?? false,
    })
    if (options.line && options.line !== plan.line)
        throw new Error("Requested release line does not match the candidate version")
    const usedFragments = options.channel === "stable" ? fragments : pending
    releasePlan.releases = [
        {
            name: sdk.packageJson.name,
            type: plan.bump,
            oldVersion: plan.currentVersion,
            newVersion: plan.version,
            changesets: usedFragments.map((fragment) => fragment.id),
        },
    ]
    releasePlan.changesets = usedFragments
    releasePlan.preState = preState
    const fragmentHashes = Object.fromEntries(
        await Promise.all(
            usedFragments.map(async (fragment) => [
                fragment.id,
                sha256(await readFile(join(workspace, ".changeset", `${fragment.id}.md`))),
            ]),
        ),
    )
    return {
        plan: {
            ...plan,
            fragments: fragmentHashes,
            noPendingChanges:
                pending.length === 0 && current.channel === options.channel && sdk.packageJson.version !== "0.0.0",
        },
        releasePlan,
        packages,
        config: configResult.config,
    }
}

export async function assertSourceReleaseState(workspace, current, fragments) {
    const canonicalIds = new Set()
    for (const fragment of fragments) {
        const id = fragment.id.startsWith("pre/") ? fragment.id.slice(4) : fragment.id
        // Changesets moves pending notes into pre/, replacing any existing same-ID note
        if (canonicalIds.has(id))
            throw new Error(`Changeset ID collision for ${id}, reconcile pending and archived notes`)
        canonicalIds.add(id)
    }
    let state
    try {
        state = JSON.parse(await readFile(join(workspace, ".changeset", "pre.json"), "utf8"))
    } catch (error) {
        if (error.code !== "ENOENT") throw new Error("Changesets prerelease state cannot be read")
    }
    if (current.channel === "stable") {
        if (state || fragments.some((fragment) => fragment.id.startsWith("pre/")))
            throw new Error("Stable source has leftover prerelease state, reconcile partial version preparation")
    } else if (!state || state.mode !== "pre" || state.tag !== current.channel)
        throw new Error("SDK source version and Changesets prerelease state disagree")
}

export async function applySourcePlan(workspace, options, prepared) {
    const result = await readSourcePlan(workspace, options)
    if (
        prepared &&
        (JSON.stringify(prepared.plan) !== JSON.stringify(result.plan) ||
            JSON.stringify(prepared.config) !== JSON.stringify(result.config) ||
            JSON.stringify(
                prepared.packages.packages.find((item) => item.packageJson.name === "@neontechspace/fluxerly")
                    .packageJson,
            ) !==
                JSON.stringify(
                    result.packages.packages.find((item) => item.packageJson.name === "@neontechspace/fluxerly")
                        .packageJson,
                ))
    )
        throw new Error("Release source inputs changed during the content guard, no version or fragment was consumed")
    const { applyReleasePlan } = await import("@changesets/apply-release-plan")
    await applyReleasePlan(result.releasePlan, result.packages, result.config, undefined, import.meta.dirname)
    if (options.channel !== "stable")
        await writeFile(
            join(workspace, ".changeset", "pre.json"),
            JSON.stringify({ mode: "pre", tag: options.channel }, null, 4) + "\n",
        )
    const manifest = JSON.parse(await readFile(join(workspace, "sdk", "package.json"), "utf8"))
    if (manifest.version !== result.plan.version || manifest.private !== true)
        throw new Error("Release source version readback failed or removed the private safeguard")
    changelogSection(await readFile(join(workspace, "sdk", "CHANGELOG.md"), "utf8"), result.plan.version)
    return result.plan
}

async function writeInitialCanaryNote(workspace) {
    const path = join(workspace, ".changeset", "initial-canary.md")
    const bytes = Buffer.from(
        '---\n"@neontechspace/fluxerly": patch\n---\n\nInitial canary release of Fluxerly.js for testing and feedback\n',
    )
    try {
        await writeFile(path, bytes, { flag: "wx" })
        return bytes
    } catch (error) {
        if (error.code === "EEXIST")
            throw new Error("Initial canary Changeset already exists, inspect it before retrying the release version action")
        throw error
    }
}

export async function versionSource({ workspace, options, registries, stage }) {
    const guardedOptions = { ...options, allowNoChanges: true }
    const prepared = await readSourcePlan(workspace, guardedOptions)
    const { guardVersionContent } = await import("./candidate.mjs")
    const guard = await guardVersionContent({
        plan: prepared.plan,
        bootstrap: options.bootstrap ?? false,
        registries,
        stage,
    })
    if (guard?.skipped)
        return {
            ...guard,
            version: prepared.plan.currentVersion,
            channel: prepared.plan.channel,
            line: prepared.plan.line,
        }
    if (prepared.plan.noPendingChanges)
        throw new Error(
            "Publishable SDK bytes changed or lack a baseline, but no pending Changesets fragment describes this release",
        )
    if (
        prepared.plan.currentVersion === "0.0.0" &&
        prepared.plan.channel === "canary" &&
        Object.keys(prepared.plan.fragments).length === 0
    ) {
        const bytes = await writeInitialCanaryNote(workspace)
        return applySourcePlan(workspace, guardedOptions, {
            ...prepared,
            plan: {
                ...prepared.plan,
                fragments: { ...prepared.plan.fragments, "initial-canary": sha256(bytes) },
            },
        })
    }
    return applySourcePlan(workspace, guardedOptions, prepared)
}

export function changelogSection(text, version) {
    const lines = text.replaceAll("\r\n", "\n").split("\n")
    const index = lines.findIndex((line) => line === `## ${version}`)
    if (index < 0) throw new Error("The reviewed SDK changelog has no candidate version section")
    const end = lines.findIndex((line, position) => position > index && line.startsWith("## "))
    return (
        lines
            .slice(index + 1, end < 0 ? undefined : end)
            .join("\n")
            .trim() + "\n"
    )
}
