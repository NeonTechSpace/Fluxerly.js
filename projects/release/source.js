// @ts-check

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "./content.js"
import { parseVersion, planNightly, planVersion, releaseBaseFor } from "./planning.js"

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
    const state = await assertSourceReleaseState(workspace, current, fragments)
    /** @type {any} */
    const preState =
        options.channel === "stable"
            ? current.channel === "stable"
                ? undefined
                : { mode: "exit", tag: current.channel }
            : { mode: "pre", tag: options.channel }
    /** @type {any} */
    const releasePlan = assembleReleasePlan(fragments, packages, configResult.config, preState)
    if (releasePlan.releases.some((release) => release.name !== sdk.packageJson.name))
        throw new Error("Changesets attempted to release a non-SDK package")
    // Archived notes retain cycle-wide compatibility impact. Pending notes determine new preview work
    const plan = planVersion({
        currentVersion: sdk.packageJson.version,
        channel: options.channel,
        epoch: options.epoch,
        pendingTypes: pending.map((fragment) => fragment.releases[0].type),
        releaseTypes: fragments.map((fragment) => fragment.releases[0].type),
        releaseBase: state?.releaseBase,
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
            noPendingChanges: pending.length === 0 && current.channel === options.channel,
        },
        releasePlan,
        packages,
        config: configResult.config,
    }
}

/**
 * Reads the source's release notes and state without changing them
 * @param {string} workspace
 */
async function readSourceNotes(workspace) {
    const { readChangesets } = await import("@changesets/read")
    const manifest = JSON.parse(await readFile(join(workspace, "sdk", "package.json"), "utf8"))
    if (manifest.name !== "@neontechspace/fluxerly" || manifest.private !== true)
        throw new Error("SDK package identity or private publication safeguard does not match")
    const fragments = await readChangesets(workspace)
    for (const fragment of fragments) {
        if (fragment.releases.length !== 1 || fragment.releases[0].name !== manifest.name)
            throw new Error("Release fragments must describe only the SDK package")
    }
    const current = parseVersion(manifest.version)
    const state = await assertSourceReleaseState(workspace, current, fragments)
    const pending = fragments.filter((fragment) => !fragment.id.startsWith("pre/"))
    return { manifest, fragments, pending, state }
}

/**
 * Plans the nightly build of the current source with its UTC build date and run number, checked against the published
 * npm versions
 * @param {string} workspace
 * @param {string[]} npmVersions
 * @param {string | undefined} date
 * @param {number | undefined} number
 */
export async function readNightlyPlan(workspace, npmVersions, date, number) {
    const { manifest, fragments, pending, state } = await readSourceNotes(workspace)
    return planNightly({
        currentVersion: manifest.version,
        pendingTypes: pending.map((fragment) => fragment.releases[0].type),
        releaseTypes: fragments.map((fragment) => fragment.releases[0].type),
        releaseBase: state?.releaseBase,
        npmVersions,
        date,
        number,
    })
}

/**
 * Formats the pending notes like a Changesets changelog section, or returns an empty string when there are none
 * @param {string} workspace
 */
export async function unreleasedNotes(workspace) {
    const { pending } = await readSourceNotes(workspace)
    return [
        ["major", "Major Changes"],
        ["minor", "Minor Changes"],
        ["patch", "Patch Changes"],
    ]
        .flatMap(([type, title]) => {
            const items = pending
                .filter((fragment) => fragment.releases[0].type === type)
                .map((fragment) => {
                    const lines = fragment.summary.trim().split("\n")
                    return `- ${[lines[0], ...lines.slice(1).map((line) => (line ? `    ${line}` : ""))].join("\n")}`
                })
            return items.length ? [`### ${title}\n\n${items.join("\n")}\n`] : []
        })
        .join("\n")
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
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
            throw new Error("Changesets prerelease state cannot be read")
    }
    if (current.channel === "stable") {
        if (state || fragments.some((fragment) => fragment.id.startsWith("pre/")))
            throw new Error("Stable source has leftover prerelease state, reconcile partial version preparation")
    } else {
        if (!state || state.mode !== "pre" || state.tag !== current.channel)
            throw new Error("SDK source version and Changesets prerelease state disagree")
        releaseBaseFor(current, state.releaseBase)
    }
    return state
}

/**
 * @param {string} workspace
 * @param {any} options
 * @param {any} [prepared]
 */
export async function applySourcePlan(workspace, options, prepared) {
    const result = await readSourcePlan(workspace, options)
    if (
        prepared &&
        (JSON.stringify(prepared.plan) !== JSON.stringify(result.plan) ||
            JSON.stringify(prepared.config) !== JSON.stringify(result.config) ||
            JSON.stringify(
                prepared.packages.packages.find((item) => item.packageJson.name === "@neontechspace/fluxerly")
                    ?.packageJson,
            ) !==
                JSON.stringify(
                    result.packages.packages.find((item) => item.packageJson.name === "@neontechspace/fluxerly")
                        ?.packageJson,
                ))
    )
        throw new Error("Release source inputs changed during the content guard, no version or fragment was consumed")
    const { applyReleasePlan } = await import("@changesets/apply-release-plan")
    await applyReleasePlan(result.releasePlan, result.packages, result.config, undefined, import.meta.dirname)
    if (options.channel !== "stable")
        await writeFile(
            join(workspace, ".changeset", "pre.json"),
            JSON.stringify({ mode: "pre", tag: options.channel, releaseBase: result.plan.releaseBase }, null, 4) + "\n",
        )
    const manifest = JSON.parse(await readFile(join(workspace, "sdk", "package.json"), "utf8"))
    if (manifest.version !== result.plan.version || manifest.private !== true)
        throw new Error("Release source version readback failed or removed the private safeguard")
    changelogSection(await readFile(join(workspace, "sdk", "CHANGELOG.md"), "utf8"), result.plan.version)
    return result.plan
}

export async function versionSource({ workspace, options, registries, stage }) {
    const guardedOptions = { ...options, allowNoChanges: true }
    const prepared = await readSourcePlan(workspace, guardedOptions)
    const { guardVersionContent } = await import("./candidate.js")
    const guard = await guardVersionContent({ plan: prepared.plan, registries, stage })
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
