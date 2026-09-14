import { Application } from "typedoc"
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join, resolve } from "node:path"
import { channelTargets, defaultVersion, parseVersion, validateSnapshot } from "./versions.mjs"

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sdkRoot = resolve(webRoot, "../sdk")
export const generatedRoot = join(webRoot, "content/docs")
const frontmatter = (title) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n`

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

export async function generateVersion(version, output) {
    if (version !== "dev") parseVersion(version)
    await mkdir(output, { recursive: true })
    const app = await Application.bootstrapWithPlugins({
        name: "Fluxerly API",
        entryPoints: [join(sdkRoot, "dist/index.d.ts"), join(sdkRoot, "dist/effect.d.ts")].map((path) =>
            path.replaceAll("\\", "/"),
        ),
        tsconfig: join(webRoot, "tsconfig.reference.json"),
        plugin: [
            "typedoc-plugin-markdown",
            "typedoc-plugin-frontmatter",
            fileURLToPath(new URL("./reference-theme.mjs", import.meta.url)),
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
        typeAliasPropertiesFormat: "table",
        publicPath: `/docs/${version}/api`,
        router: "kind",
        outputs: [{ name: "markdown", path: join(output, "api") }],
        entryFileName: "index",
        treatWarningsAsErrors: true,
        validation: { notExported: false },
    })
    const project = await app.convert()
    if (!project || app.logger.hasErrors()) throw new Error("SDK reference conversion failed")
    const defaultApi = project.children?.find((child) => child.name === "index")
    const native = project.children?.find((child) => child.name === "effect")
    if (!defaultApi || !native) throw new Error("The two public SDK entry points were not found")
    defaultApi.name = "js-ts"
    native.name = "Effect"
    await app.generateOutputs(project)
    if (app.logger.hasErrors() || app.logger.hasWarnings())
        throw new Error("SDK reference generation reported unresolved diagnostics")
    const reflections = Object.values(project.reflections)
    for (const name of ["createClient", "Message", "SendOptions"])
        if (!reflections.some((reflection) => reflection.name === name))
            throw new Error(`Missing public reference: ${name}`)
    for (const name of ["Rest", "Gateway", "validateMessageBody", "InternalClient"])
        if (reflections.some((reflection) => reflection.name === name))
            throw new Error(`Internal-only declaration escaped into reference: ${name}`)
    const intro = `Fluxerly.js connects your Node.js app to Fluxer.
Use it to send messages, respond to events and build your own bot in JavaScript or TypeScript

${version === "dev" ? "These docs preview unreleased Canary code. There is no published package matching this preview" : `You're reading the docs for SDK **${version}**`}

## Start your bot

Follow [Start your first bot](/docs/${version}/quick-start/) to install the SDK and make a bot that replies to !ping.
The guide uses JavaScript, with no TypeScript setup or Effect knowledge required

## Find a method

Already building? The [API reference](/docs/${version}/api/) lists the available methods and types.
Use search to jump to a name such as \`createClient\`

See the [changelog](/docs/${version}/changelog/) for version history
`
    await writeFile(join(output, "index.md"), frontmatter("Build a Fluxer bot") + intro)
    const guide = await readFile(join(webRoot, "content/guides/quick-start.md"), "utf8")
    const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"))
    const installation =
        (version === "dev" ? "" : `This installs SDK **${version}**, matching these docs\n`) +
        `\n\`\`\`command\n${JSON.stringify({ kind: "install", package: manifest.name, version })}\n\`\`\`\n`
    await writeFile(
        join(output, "quick-start.md"),
        guide.replaceAll("{{version}}", version)
            .replace("{{installation}}", installation)
            .replaceAll("{{effect-version}}", manifest.peerDependencies.effect),
    )
    let changelog
    try {
        changelog = await readFile(join(sdkRoot, "CHANGELOG.md"), "utf8")
    } catch (error) {
        if (error.code !== "ENOENT") throw error
    }
    await writeFile(
        join(output, "changelog.md"),
        frontmatter("Changelog") +
            (version === "dev"
                ? "This is unreleased Canary history. Prepared versions are not proof of registry publication\n\n"
                : `Release history recorded for SDK ${version}\n\n`) +
            (changelog || "No package releases have been recorded yet\n"),
    )
    await writeFile(
        join(output, "meta.json"),
        JSON.stringify({
            title: version === "dev" ? "Canary" : version,
            root: "version",
            pages: ["index", "quick-start", "api", "changelog"],
        }),
    )
    await writeFile(join(output, "api/meta.json"), JSON.stringify({ title: "API reference" }))
}

export async function generate({ releasesDirectory = join(webRoot, "released") } = {}) {
    // This path is exclusively generated output, never an authored content directory
    if (generatedRoot !== resolve(webRoot, "content/docs")) throw new Error("Unsafe generated docs path")
    await rm(generatedRoot, { recursive: true, force: true })
    await generateVersion("dev", join(generatedRoot, "dev"))
    const versions = []
    await mkdir(releasesDirectory, { recursive: true })
    for (const name of await readdir(releasesDirectory)) {
        if (!name.endsWith(".json")) continue
        const snapshot = validateSnapshot(JSON.parse(await readFile(join(releasesDirectory, name), "utf8")))
        if (versions.includes(snapshot.version)) throw new Error("Duplicate docs version")
        versions.push(snapshot.version)
        for (const file of snapshot.files) {
            const target = join(generatedRoot, snapshot.version, file.path)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, file.content)
        }
    }
    const targets = channelTargets(versions)
    for (const { version, label } of targets) {
        const target = join(generatedRoot, version, "meta.json")
        const metadata = JSON.parse(await readFile(target, "utf8"))
        await writeFile(
            target,
            JSON.stringify({
                ...metadata,
                title: version === "dev" ? label : `${label} · ${version}`,
                root: "version",
            }),
        )
    }
    const selected = new Set(targets.map((target) => target.version))
    await writeFile(
        join(generatedRoot, "meta.json"),
        JSON.stringify({
            pages: [...targets.map((target) => target.version), ...versions.filter((v) => !selected.has(v))],
        }),
    )
    await writeFile(
        join(webRoot, "content/versions.json"),
        JSON.stringify({ versions, targets, defaultVersion: defaultVersion(versions) }, null, 2) + "\n",
    )
    console.log(`Generated development reference and ${versions.length} released documentation snapshots`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generate()
