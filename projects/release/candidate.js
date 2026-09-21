import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { assertExactFiles, contentFingerprint, exactFiles, readDirectory, readNpmTarball, sha256 } from "./content.js"
import { parseVersion, selectBaseline } from "./planning.js"
import { assertSourceReleaseState, changelogSection } from "./source.js"

export async function guardVersionContent({ plan, bootstrap, registries, stage }) {
    const inventory = await registries.inventory("@neontechspace/fluxerly", { bootstrap })
    if (inventory.npmVersions.includes(plan.version))
        throw new Error("Prospective release version already exists")
    const baselineVersion = selectBaseline({ ...inventory, version: plan.version, channel: plan.channel, bootstrap })
    if (baselineVersion === null) return
    const baseline = await registries.baseline("@neontechspace/fluxerly", baselineVersion)
    const root = await mkdtemp(join(tmpdir(), "fluxerly-release-guard-"))
    try {
        const candidate = await stage({ version: plan.version, output: join(root, "candidate") })
        const npm = await readDirectory(candidate.npm.directory)
        if (contentFingerprint(npm) === baseline.contentFingerprint)
            return {
                skipped: true,
                reason: "Publishable SDK bytes are unchanged from the previous published channel and line baseline",
                baseline: baselineVersion,
            }
    } finally {
        if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir()) + sep))
            throw new Error("Temporary release guard directory escaped its owner")
        await rm(root, { recursive: true })
    }
}

export async function prepareCandidate({ workspace, output, bootstrap = false, line, docs, registries, stage }) {
    if (
        !isAbsolute(output) ||
        resolve(output) === workspace ||
        resolve(output).startsWith(join(workspace, "sdk") + sep)
    )
        throw new Error("Candidate output must be a new absolute directory outside SDK source")
    const source = JSON.parse(await readFile(join(workspace, "sdk", "package.json"), "utf8"))
    const version = parseVersion(source.version)
    if (source.name !== "@neontechspace/fluxerly" || source.private !== true || source.version === "0.0.0")
        throw new Error("Prepare a reviewed SDK release version before staging")
    if (line && version.line !== line) throw new Error("Requested release line does not match the reviewed version")
    const notes = changelogSection(await readFile(join(workspace, "sdk", "CHANGELOG.md"), "utf8"), source.version)
    const { readChangesets } = await import("@changesets/read")
    const fragments = await readChangesets(workspace)
    await assertSourceReleaseState(workspace, version, fragments)
    if (fragments.some((fragment) => !fragment.id.startsWith("pre/")))
        throw new Error("Pending Changesets fragments must be versioned and reviewed before candidate staging")
    let documentation
    let sourceCommit = null
    if (docs) {
        documentation = await readFile(docs)
        const snapshot = JSON.parse(documentation.toString("utf8"))
        if (
            snapshot.schemaVersion !== 1 ||
            snapshot.version !== source.version ||
            !Array.isArray(snapshot.files) ||
            !/^[a-f0-9]{40}$/.test(snapshot.sourceCommit)
        )
            throw new Error("Documentation snapshot does not match the reviewed SDK candidate")
        sourceCommit = snapshot.sourceCommit
    }
    const inventory = await registries.inventory(source.name, { bootstrap })
    if (inventory.npmVersions.includes(source.version))
        throw new Error("Candidate version already exists, recover using its original immutable candidate")
    const baselineVersion = selectBaseline({
        ...inventory,
        version: source.version,
        channel: version.channel,
        bootstrap,
    })
    const baseline = baselineVersion === null ? null : await registries.baseline(source.name, baselineVersion)
    try {
        await lstat(output)
        throw new Error("Candidate output already exists, use a new directory")
    } catch (error) {
        if (error.code !== "ENOENT") throw error
    }
    const intendedOutput = join(await realpath(dirname(output)), basename(output))
    const staged = await stage({ version: source.version, output })
    const npm = await readDirectory(staged.npm.directory)
    const files = exactFiles(npm)
    const fingerprint = contentFingerprint(npm)
    if (baseline?.contentFingerprint === fingerprint) {
        const actualOutput = await realpath(output)
        if (actualOutput !== intendedOutput) throw new Error("Skipped candidate directory escaped its verified owner")
        await rm(actualOutput, { recursive: true })
        return {
            skipped: true,
            reason: "Publishable SDK bytes are unchanged from the previous published channel and line baseline",
            baseline: baselineVersion,
            version: source.version,
            channel: version.channel,
            line: version.line,
        }
    }
    assertExactFiles(readNpmTarball(await readFile(staged.npm.tarball)), files)
    await writeFile(join(output, "notes.md"), notes)
    if (documentation) await writeFile(join(output, "docs.json"), documentation)
    const artifacts = await readDirectory(output)
    const candidate = {
        schema: 1,
        name: source.name,
        version: source.version,
        channel: version.channel,
        line: version.line,
        sourceCommit,
        bootstrap,
        baseline,
        contentFingerprint: fingerprint,
        files,
        artifacts: exactFiles(artifacts),
        docs: documentation ? { path: "docs.json", sha256: sha256(documentation) } : null,
    }
    const bytes = Buffer.from(JSON.stringify(candidate, null, 4) + "\n")
    await writeFile(join(output, "candidate.json"), bytes, { flag: "wx" })
    await writeFile(join(output, "checksum.txt"), sha256(bytes) + "\n", { flag: "wx" })
    await readCandidate(output)
    return {
        directory: output,
        name: candidate.name,
        version: candidate.version,
        channel: candidate.channel,
        line: candidate.line,
        checksum: sha256(bytes),
        baseline: baselineVersion,
    }
}

export async function readCandidate(directory, { checksum } = {}) {
    const bytes = await readFile(join(directory, "candidate.json"))
    const actualChecksum = sha256(bytes)
    if (checksum !== undefined && (!/^[a-f0-9]{64}$/.test(checksum) || checksum !== actualChecksum))
        throw new Error("Candidate does not match the externally reviewed checksum")
    if ((await readFile(join(directory, "checksum.txt"), "utf8")).trim() !== actualChecksum)
        throw new Error("Candidate record checksum does not match")
    const candidate = JSON.parse(bytes.toString("utf8"))
    if (candidate.schema !== 1 || candidate.name !== "@neontechspace/fluxerly")
        throw new Error("Unknown release candidate identity or schema")
    const version = parseVersion(candidate.version)
    if (version.channel !== candidate.channel || version.line !== candidate.line)
        throw new Error("Candidate version, channel and line disagree")
    const artifacts = await readDirectory(directory)
    artifacts.delete("candidate.json")
    artifacts.delete("checksum.txt")
    assertExactFiles(artifacts, candidate.artifacts)
    const npm = await readDirectory(join(directory, "npm"))
    assertExactFiles(npm, candidate.files)
    assertExactFiles(readNpmTarball(await readFile(join(directory, "sdk.tgz"))), candidate.files)
    if (contentFingerprint(npm) !== candidate.contentFingerprint)
        throw new Error("Candidate content fingerprint does not match")
    if (candidate.docs) {
        if (candidate.docs.path !== "docs.json") throw new Error("Candidate documentation asset path is invalid")
        const bytes = await readFile(join(directory, "docs.json"))
        const snapshot = JSON.parse(bytes.toString("utf8"))
        if (
            candidate.docs.sha256 !== sha256(bytes) ||
            snapshot.schemaVersion !== 1 ||
            snapshot.version !== candidate.version ||
            snapshot.sourceCommit !== candidate.sourceCommit
        )
            throw new Error("Candidate documentation identity does not match its bound snapshot")
    }
    return { ...candidate, checksum: actualChecksum }
}
