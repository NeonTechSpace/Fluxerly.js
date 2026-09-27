import { Application, ReflectionCategory } from "typedoc"
import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join, resolve } from "node:path"
import { channelTargets, defaultVersion, parseVersion, publishedSnapshotFiles, retainedVersions, validateSnapshot } from "./versions.js"
import { linkPlaceholder, materializeFiles, currentSnapshotSchema } from "./snapshot-schema.js"
import { categoryAnchor, referenceRouter, taskIndexFor } from "./reference-theme.js"
import { expandStarterExamples } from "./starter-examples.js"
import { referenceEntries } from "./reference-entries.js"
import { codePageSlug, generateCodeCatalogue } from "./code-catalogue.js"
import { readSourcePlan } from "../../release/source.js"

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sdkRoot = resolve(webRoot, "../sdk")
export const guidesRoot = join(webRoot, "content/guides")
export const generatedRoot = join(webRoot, "content/docs")
const partialsRoot = join(webRoot, "content/partials")
// Effect's module reference pages share each re-exported namespace name
const effectModules = ["Cause", "Clock", "Deferred", "Effect", "Exit", "Fiber", "Layer", "Logger", "LogLevel", "Option",
    "Queue", "Redacted", "Schedule", "Scope", "Stream"]
const effectReference = "https://effect.website/docs/v4/api/effect"
const frontmatter = (title, navTitle) =>
    `---\ntitle: ${JSON.stringify(title)}\n${navTitle ? `navTitle: ${JSON.stringify(navTitle)}\n` : ""}---\n\n`
const guideSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const separator = /^(?:---(?:\[[^\]]+\])?.+---|---)$/
const generatedPages = new Set(["index", "api", "changelog", codePageSlug])

async function readGuideInventory(directory = guidesRoot) {
    const entries = await readdir(directory, { withFileTypes: true })
    const guideFiles = new Set()
    let inventory
    for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile())
            throw new Error("Authored guides must be flat regular files")
        if (entry.name === "meta.json") {
            inventory = join(directory, entry.name)
            continue
        }
        if (!entry.name.endsWith(".md")) throw new Error("Authored guides must be Markdown files")
        guideFiles.add(entry.name.slice(0, -3))
    }
    if (!inventory) throw new Error("Authored guide inventory is missing")
    let metadata
    try {
        metadata = JSON.parse(await readFile(inventory, "utf8"))
    } catch (error) {
        throw new Error("Authored guide inventory is invalid", { cause: error })
    }
    if (
        !metadata ||
        Array.isArray(metadata) ||
        Object.keys(metadata).length !== 1 ||
        !Array.isArray(metadata.pages) ||
        metadata.pages.length === 0
    )
        throw new Error("Authored guide inventory must contain one non-empty pages array")
    const navigation = metadata.pages
    const listed = new Set()
    for (const page of navigation) {
        if (typeof page !== "string")
            throw new Error("Authored guide inventory contains an unsafe or duplicate slug")
        if (separator.test(page)) continue
        if (!guideSlug.test(page) || listed.has(page))
            throw new Error("Authored guide inventory contains an unsafe or duplicate slug")
        listed.add(page)
        if (!guideFiles.has(page) && !generatedPages.has(page))
            throw new Error(`Authored guide navigation references a missing page: ${page}`)
    }
    const unlisted = [...guideFiles].filter((page) => !listed.has(page))
    if (unlisted.length > 0) throw new Error(`Authored guide is not listed: ${unlisted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ")}.md`)
    const guides = await Promise.all(
        navigation
            .filter((slug) => guideFiles.has(slug))
            .map(async (slug) => ({
                slug,
                content: await expandStarterExamples(await readFile(join(directory, `${slug}.md`), "utf8")),
            })),
    )
    return { guides, navigation }
}

export async function authoredGuides(directory = guidesRoot) {
    return (await readGuideInventory(directory)).guides
}

export async function authoredGuideNavigation(directory = guidesRoot) {
    return (await readGuideInventory(directory)).navigation
}

export async function filesIn(directory, prefix = "") {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Documentation output must not contain symbolic links")
        const path = prefix + entry.name
        if (entry.isDirectory()) files.push(...(await filesIn(join(directory, entry.name), `${path}/`)))
        else files.push({ path, content: await readFile(join(directory, entry.name), "utf8") })
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function referenceOptions({ entryPoints, tsconfig, output, publicPath }) {
    return {
        name: "Fluxerly API",
        entryPoints: entryPoints.map((path) => path.replaceAll("\\", "/")),
        tsconfig,
        plugin: [
            "typedoc-plugin-markdown",
            "typedoc-plugin-frontmatter",
            fileURLToPath(new URL("./reference-theme.js", import.meta.url)),
        ],
        theme: "fluxerly",
        readme: "none",
        excludePrivate: true,
        excludeProtected: true,
        excludeInternal: true,
        excludeExternals: true,
        disableSources: true,
        hidePageHeader: true,
        hideBreadcrumbs: true,
        hidePageTitle: true,
        useHTMLAnchors: true,
        sanitizeComments: true,
        parametersFormat: "table",
        interfacePropertiesFormat: "table",
        classPropertiesFormat: "table",
        typeAliasPropertiesFormat: "table",
        enumMembersFormat: "table",
        typeDeclarationFormat: "table",
        // The plugin omits columns without values. Sources are disabled, so their column is always hidden
        tableColumnSettings: { hideSources: true },
        categorizeByGroup: false,
        defaultCategory: "Other",
        navigation: { includeCategories: true, includeGroups: true },
        externalSymbolLinkMappings: {
            effect: Object.fromEntries([...effectModules.map((name) => [name, `${effectReference}/${name}`]), ["*", effectReference]]),
        },
        publicPath,
        router: referenceRouter,
        outputs: [{ name: "markdown", path: output }],
        entryFileName: "index",
        includeHierarchySummary: false,
        treatWarningsAsErrors: true,
        validation: { notExported: true, invalidLink: true, notDocumented: true },
    }
}

/**
 * Give re-exported symbols the category of the declaration they point to.
 * TypeDoc places re-exports in the default category because their category tag belongs to the other entry point
 */
export function categorizeReferences(entries) {
    const categoryOf = new Map()
    for (const entry of entries)
        for (const category of entry.categories ?? [])
            if (category.title !== "Other") for (const child of category.children) categoryOf.set(child.id, category.title)
    for (const entry of entries) {
        const other = entry.categories?.find((category) => category.title === "Other")
        if (!other) continue
        other.children = other.children.filter((child) => {
            if (!child.isReference?.()) return true
            const title = categoryOf.get(child.getTargetReflectionDeep().id)
            if (!title) return true
            let category = entry.categories.find((candidate) => candidate.title === title)
            if (!category) {
                category = new ReflectionCategory(title)
                entry.categories.push(category)
                // Keep the default category last, where TypeDoc places it
                const rank = (item) => (item.title === "Other" ? 1 : 0)
                entry.categories.sort((a, b) => rank(a) - rank(b) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
            }
            category.children.push(child)
            category.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            return false
        })
        if (other.children.length === 0) entry.categories = entry.categories.filter((category) => category !== other)
    }
}

/**
 * Convert public declarations to generated reference Markdown.
 * Missing comments and unexported referenced types are reported as source documentation gaps.
 * Every other diagnostic fails generation
 */
export async function renderReference({ entryPoints, tsconfig, output, publicPath, modules = referenceEntries }) {
    const app = await Application.bootstrapWithPlugins(referenceOptions({ entryPoints, tsconfig, output, publicPath }))
    const project = await app.convert()
    if (!project || app.logger.hasErrors()) throw new Error("SDK reference conversion failed")
    const entries = modules.map(({ module }) => project.children?.find((child) => child.name === module))
    const missing = modules.filter((_, index) => !entries[index]).map(({ module }) => module)
    if (missing.length) throw new Error(`Public SDK entry points were not found: ${missing.join(", ")}`)
    // TypeDoc names modules after their declaration files. Pages and URLs use the reference names
    entries.forEach((entry, index) => { entry.name = modules[index].name })
    categorizeReferences(entries)
    const gaps = { undocumented: [], notExported: [] }
    const validationWarning = app.logger.validationWarning.bind(app.logger)
    app.logger.validationWarning = (message, ...rest) => {
        if (message.endsWith(" does not have any documentation")) gaps.undocumented.push(message)
        else if (message.endsWith(" but not included in the documentation")) gaps.notExported.push(message)
        else validationWarning(message, ...rest)
    }
    app.validate(project)
    if (app.logger.hasErrors() || app.logger.hasWarnings())
        throw new Error("SDK reference validation reported unresolved diagnostics")
    await app.generateOutputs(project)
    if (app.logger.hasErrors() || app.logger.hasWarnings())
        throw new Error("SDK reference generation reported unresolved diagnostics")
    // Rendering can add categories. Read them after output so navigation matches the pages
    const categories = Object.fromEntries(entries.map((entry) => [entry.name,
        (entry.categories ?? []).map((category) => ({ title: category.title, anchor: categoryAnchor(category.title) }))]))
    // TypeDoc percent-encodes placeholder braces in link destinations
    const encoded = (value) => value.replaceAll("{", "%7B").replaceAll("}", "%7D")
    for (const file of await filesIn(output))
        if (file.content.includes(encoded(publicPath)))
            await writeFile(join(output, file.path), file.content.replaceAll(encoded(publicPath), publicPath))
    const tasks = taskIndexFor(app)?.replaceAll(encoded(publicPath), publicPath)
    return { project, categories, gaps, tasks }
}

export async function generateVersion(version, output, { plannedVersion } = {}) {
    if (version !== "preview") parseVersion(version)
    if (version === "preview" && plannedVersion) parseVersion(plannedVersion)
    await mkdir(output, { recursive: true })
    const { guides, navigation } = await readGuideInventory()
    const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"))
    const declarations = referenceEntries.map((entry) => join(sdkRoot, "dist", entry.declarations))
    const missing = declarations.filter((path) => !existsSync(path))
    if (missing.length)
        throw new Error(
            `The SDK build is missing ${missing.map((path) => resolve(path)).join(", ")}. ` +
                "Run pnpm docs:dev, which builds the SDK first, or run pnpm --filter @neontechspace/fluxerly build from projects/",
        )
    const { project, categories, gaps, tasks } = await renderReference({
        entryPoints: declarations,
        tsconfig: join(webRoot, "tsconfig.reference.json"),
        output: join(output, "api"),
        // Generated files keep a placeholder. Each served path fills it when the site is built
        publicPath: `${linkPlaceholder}/api`,
    })
    const gapReport = Object.entries(gaps)
        .filter(([, messages]) => messages.length)
        .map(([kind, messages]) => `Reference source gaps (${kind}): ${messages.length}\n  ${messages.join("\n  ")}`)
    // Fix gaps in SDK source comments or exports, not in generated output
    if (gapReport.length) throw new Error(gapReport.join("\n"))
    const reflections = Object.values(project.reflections)
    for (const name of ["createClient", "Message", "SendOptions"])
        if (!reflections.some((reflection) => reflection.name === name))
            throw new Error(`Missing public reference: ${name}`)
    for (const name of ["RestRuntime", "RestOwner", "superviseShards", "routeDispatch"])
        if (reflections.some((reflection) => reflection.name === name))
            throw new Error(`Internal-only declaration escaped into reference: ${name}`)
    const releaseStatus = version === "preview"
        ? `These docs describe changes in development${plannedVersion ? ` for SDK **${plannedVersion}**` : ""}. This version has not been released and cannot be installed yet`
        : `These docs cover SDK **${version}**`
    await writeFile(join(output, "index.md"),
        (await readFile(join(partialsRoot, "overview.md"), "utf8")).replaceAll("{{release-status}}", releaseStatus))
    const installation = version === "preview"
        ? "This version is not available to install yet. Select a released version of the docs to follow this tutorial\n"
        : `This installs SDK **${version}**, matching these docs\n\n\`\`\`command\n${JSON.stringify({ kind: "install", package: manifest.name, version })}\n\`\`\`\n`
    for (const guide of guides) {
        // Guide links already use the snapshot link placeholder
        const content = guide.content
            .replaceAll("{{installation}}", installation)
            .replaceAll("{{effect-version}}", manifest.peerDependencies.effect)
        if (content.replaceAll(linkPlaceholder, "").includes("{{"))
            throw new Error(`Guide ${guide.slug} contains an unknown placeholder`)
        await writeFile(join(output, `${guide.slug}.md`), content)
    }
    // Generated from the SDK code catalogue, which fails here when a code has no entry
    await writeFile(join(output, `${codePageSlug}.md`), await generateCodeCatalogue(sdkRoot))
    let changelog
    try {
        changelog = await readFile(join(sdkRoot, "CHANGELOG.md"), "utf8")
    } catch (error) {
        if (error.code !== "ENOENT") throw error
    }
    await writeFile(
        join(output, "changelog.md"),
        frontmatter("Changelog") +
            (version === "preview"
                ? "This is unreleased source history. Prepared versions are not proof of registry publication\n\n"
                : `Release history recorded for SDK ${version}\n\n`) +
            (changelog || "No package releases have been recorded yet\n"),
    )
    await writeFile(
        join(output, "meta.json"),
        JSON.stringify({
            title: version === "preview" ? "Source preview" : version,
            root: "version",
            pages: navigation,
        }),
    )
    if (tasks) await writeFile(join(output, "api/tasks.md"),
        (await readFile(join(partialsRoot, "api-tasks.md"), "utf8")).replace("{{task-index}}", () => tasks.trim()))
    await writeFile(join(output, "api/meta.json"), JSON.stringify({ title: "API reference", categories }))
}

async function writeFiles(directory, files) {
    for (const file of files) {
        const target = join(directory, file.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
    }
}

export async function generate({ releasesDirectory = join(webRoot, "released"), publicBuild = false, plannedVersion, previewChannel } = {}) {
    // This path is exclusively generated output, never an authored content directory
    if (generatedRoot !== resolve(webRoot, "content/docs")) throw new Error("Unsafe generated docs path")
    await mkdir(releasesDirectory, { recursive: true })
    const snapshots = []
    const importedVersions = []
    for (const name of await readdir(releasesDirectory)) {
        if (!name.endsWith(".json")) continue
        const snapshot = validateSnapshot(JSON.parse(await readFile(join(releasesDirectory, name), "utf8")))
        if (importedVersions.includes(snapshot.version)) throw new Error("Duplicate docs version")
        importedVersions.push(snapshot.version)
        snapshots.push(snapshot)
    }
    const versions = retainedVersions(importedVersions)
    const targets = channelTargets(versions)
    const selectedVersion = defaultVersion(versions)
    if (publicBuild && !selectedVersion) throw new Error("Public documentation requires an imported published snapshot")
    if (!publicBuild && plannedVersion === undefined) {
        const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"))
        const current = parseVersion(manifest.version)
        const channel = previewChannel ?? current.channel
        const plan = await readSourcePlan(resolve(webRoot, ".."), { channel, allowNoChanges: true })
        plannedVersion = plan.plan.noPendingChanges ? null : plan.plan.version
    }
    await rm(generatedRoot, { recursive: true, force: true })
    if (!publicBuild) {
        const preview = join(generatedRoot, "preview")
        await generateVersion("preview", preview, { plannedVersion })
        await writeFiles(preview, materializeFiles(await filesIn(preview), { schemaVersion: currentSnapshotSchema, path: "preview" }))
    }
    for (const snapshot of snapshots.filter((snapshot) => versions.includes(snapshot.version))) {
        const channel = parseVersion(snapshot.version).channel
        const path = channel === "stable" ? snapshot.version : channel
        await writeFiles(join(generatedRoot, path), materializeFiles(publishedSnapshotFiles(snapshot),
            { schemaVersion: snapshot.schemaVersion, sourceVersion: snapshot.version, path }))
    }
    for (const { version, label, path } of targets) {
        const target = join(generatedRoot, path, "meta.json")
        const metadata = JSON.parse(await readFile(target, "utf8"))
        await writeFile(
            target,
            JSON.stringify({
                ...metadata,
                title: `${label} · ${version}`,
                root: "version",
            }),
        )
    }
    const selected = new Set(targets.map((target) => target.version))
    // Latest is an edge redirect to this path, not another generated copy
    const latestPath = targets.find((target) => target.version === selectedVersion)?.path ?? null
    await writeFile(
        join(generatedRoot, "meta.json"),
        JSON.stringify({
            pages: [...(!publicBuild ? ["preview"] : []), ...targets.map((target) => target.path), ...versions.filter((v) => !selected.has(v))],
        }),
    )
    await writeFile(
        join(webRoot, "content/versions.json"),
        JSON.stringify({ versions, targets, defaultVersion: selectedVersion, latestPath, previewVersion: publicBuild ? null : plannedVersion }, null, 2) + "\n",
    )
    console.log(`Generated ${publicBuild ? "public" : "local"} documentation with ${versions.length} released snapshots`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2)
    if (args.length === 0) await generate()
    else if (args[0] === "--public" && args.length === 1) await generate({ publicBuild: true })
    else if (args[0] === "--preview-channel" && args.length === 2)
        await generate({ previewChannel: args[1] })
    else throw new Error("Use generate.js [--public | --preview-channel CHANNEL]")
}
