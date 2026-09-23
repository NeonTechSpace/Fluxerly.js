import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gzipSync } from "node:zlib"

export async function fixture(version = "0.0.0") {
    const root = await mkdtemp(join(tmpdir(), "fluxerly-release-test-"))
    await write(join(root, "package.json"), { private: true })
    await write(join(root, "pnpm-workspace.yaml"), "packages:\n  - sdk\n  - web\n  - release\n")
    await write(join(root, "sdk/package.json"), {
        name: "@neontechspace/fluxerly",
        version,
        private: true,
        type: "module",
    })
    await write(join(root, "web/package.json"), { name: "fluxerly-docs", private: true })
    await write(join(root, "release/package.json"), { name: "@fluxerly/release", private: true })
    await write(join(root, ".changeset/config.json"), {
        changelog: "@changesets/cli/changelog",
        commit: false,
        linked: [],
        access: "public",
        baseBranch: "main",
        updateInternalDependencies: "patch",
        ignore: ["fluxerly-docs", "@fluxerly/release"],
        privatePackages: { version: true, tag: false },
    })
    const channel = /-(canary|rc)\.\d+$/.exec(version)?.[1]
    if (channel) await write(join(root, ".changeset/pre.json"), { mode: "pre", tag: channel, releaseBase: null })
    return root
}

export async function write(path, value) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
        path,
        typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 4) + "\n",
    )
}

export async function note(root, id, type, text) {
    await write(join(root, ".changeset", `${id}.md`), `---\n"@neontechspace/fluxerly": ${type}\n---\n\n${text}\n`)
}

export function packages(version, content = "export const value = 1\n", description = "SDK") {
    const common = [
        ["dist/index.js", Buffer.from(content)],
        ["README.md", Buffer.from("SDK guide\n")],
        ["CHANGELOG.md", Buffer.from(`## ${version}\n`)],
    ]
    return new Map([
        ...common,
        ["package.json", Buffer.from(JSON.stringify({ name: "@neontechspace/fluxerly", version, description }))],
    ])
}

export function tarball(files) {
    const blocks = []
    for (const [path, content] of files) {
        const header = Buffer.alloc(512)
        const field = (offset, size, value) => header.write(value, offset, size, "utf8")
        field(0, 100, `package/${path}`)
        field(100, 8, "0000644\0")
        field(124, 12, content.length.toString(8).padStart(11, "0") + "\0")
        header.fill(32, 148, 156)
        field(156, 1, "0")
        field(257, 6, "ustar\0")
        const checksum = header.reduce((sum, byte) => sum + byte, 0)
        field(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ")
        blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

export function stageFixture(content = "export const value = 1\n") {
    return async ({ version, output }) => {
        await mkdir(output)
        const values = packages(version, content)
        for (const [path, bytes] of values) await write(join(output, "npm", path), bytes)
        await write(join(output, "sdk.tgz"), tarball(values))
        const manifestPath = join(output, "manifest.json")
        await write(manifestPath, { name: "@neontechspace/fluxerly", version, npm: [], tarball: {} })
        return {
            npm: { directory: join(output, "npm"), tarball: join(output, "sdk.tgz") },
            manifestPath,
        }
    }
}
