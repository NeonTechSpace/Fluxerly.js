import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { filesIn, renderReference } from "../scripts/generate.js"
import { referenceEntries } from "../scripts/reference-entries.js"
import { between, find, findAll, headingAfterAnchor, href, isHeading, normalizedText, renderMarkdown } from "./html.js"

// Small declaration fixtures exercise the reference layout without depending on current SDK exports
async function render(t, { categories, reexport = false, modules = referenceEntries }) {
    const directory = await mkdtemp(join(tmpdir(), "fluxerly-reference-layout-"))
    t.after(async () => {
        if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unexpected reference fixture directory")
        await rm(directory, { recursive: true, force: true })
    })
    const tag = (name) => categories ? `\n * @category ${name}` : ""
    await writeFile(join(directory, "index.d.ts"), `/**
 * Fixture entry point
 * @module
 */
/**
 * Options for one message${tag("Messages")}
 */
export interface SendOptions {
    /** Text to send */
    readonly content: string
}
/**
 * Message operations${tag("Messages")}
 */
export interface Messages {
    /** Send a message to a channel */
    send(options: SendOptions): void
}
/**
 * A bot client
 */
export interface Client {
    /** Message operations */
    readonly messages: Messages
    /**
     * Connect the gateway and wait until every shard
     * is ready. Later sentences stay on the member page
     */
    connect(): void
}
/**
 * Create a bot client${tag("Messages")}
 */
export declare function createClient(): Client
/** Supported message kinds */
export type MessageKind = "text" | "file"
`)
    await writeFile(join(directory, "effect.d.ts"), `/**
 * Fixture Effect entry point
 * @module
 */
/** A fixture value${reexport ? tag("Options") : ""} */
export declare const value: number
${reexport ? 'export type { SendOptions } from "./index.js"\n' : ""}`)
    // Testing entry points declare their own client and share fixtures, like the SDK's testing modules
    await writeFile(join(directory, "testing.d.ts"), `/**
 * Fixture testing entry point
 * @module
 */
import type { Client } from "./index.js"
/**
 * A client connected to an in-memory transport${tag("Testing")}
 */
export interface TestClient {
    /** The client under test */
    readonly client: Client
    /** Deliver a gateway dispatch */
    emit(event: string): void
}
/**
 * Create a test client${tag("Testing")}
 */
export declare function createTestClient(): TestClient
/** Token used by fixture messages${tag("Testing")} */
export declare const fixtureToken: string
`)
    await writeFile(join(directory, "effect-testing.d.ts"), `/**
 * Fixture Effect testing entry point
 * @module
 */
/**
 * An Effect client connected to an in-memory transport${tag("Testing")}
 */
export interface TestClient {
    /** Deliver a gateway dispatch */
    emit(event: string): void
}
export { fixtureToken } from "./testing.js"
`)
    const declarations = modules.map((entry) => entry.declarations)
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
        include: declarations,
    }))
    const output = join(directory, "api")
    const result = await renderReference({
        entryPoints: declarations.map((file) => join(directory, file)),
        tsconfig: join(directory, "tsconfig.json"),
        output,
        publicPath: "/docs/{{version}}/api",
        modules,
    })
    return { ...result, files: await filesIn(output), read: (path) => readFile(join(output, path), "utf8") }
}

const placeholder = "/docs/{{version}}/api"
const links = (tree) => findAll(tree, "a").filter((link) => link.properties.href !== undefined)
const linksTo = (tree, target) => links(tree).filter((link) => href(link) === `${placeholder}/${target}`)
// A heading of any depth follows each symbol anchor, so layout depth and spacing stay free
function assertAnchoredHeading(tree, id, name) {
    const heading = headingAfterAnchor(tree, id)
    assert.ok(heading, `Missing heading after anchor ${id}`)
    assert.ok(normalizedText(heading).includes(name), `${id}: ${normalizedText(heading)}`)
}

test("Classes and interfaces keep pages while functions, variables and type aliases join their entry point", async (t) => {
    const { files, read } = await render(t, { categories: false })
    const paths = files.map((file) => file.path)
    assert.ok(paths.includes("interfaces/js-ts.Client.md"))
    assert.ok(paths.includes("interfaces/js-ts.SendOptions.md"))
    assert.ok(!paths.some((path) => /^(?:functions|variables|types)\//.test(path)))
    const { tree: entry } = await renderMarkdown(await read("modules/js-ts.md"))
    assertAnchoredHeading(entry, "createclient", "createClient")
    assertAnchoredHeading(entry, "messagekind", "MessageKind")
    assertAnchoredHeading((await renderMarkdown(await read("modules/Effect.md"))).tree, "value", "value")
    // Generated links keep the snapshot placeholder unencoded for later substitution
    assert.ok(!files.some((file) => file.content.includes("%7B%7Bversion%7D%7D")))
    assert.ok(linksTo(entry, "interfaces/js-ts.Client/").length > 0)
})

test("Entry points use source categories when present and plain groups without them", async (t) => {
    const plain = await render(t, { categories: false })
    assert.deepEqual(plain.categories, { "js-ts": [], Effect: [], testing: [], "Effect-testing": [] })
    const { tree: plainEntry } = await renderMarkdown(await plain.read("modules/js-ts.md"))
    assert.deepEqual(findAll(plainEntry, (node) => String(node.properties.id ?? "").startsWith("category-")), [])

    const categorized = await render(t, { categories: true })
    assert.deepEqual(categorized.categories["js-ts"].map((category) => category.title), ["Messages", "Other"])
    assert.deepEqual(categorized.categories.Effect, [])
    assert.deepEqual(categorized.categories.testing.map((category) => category.title), ["Testing"])
    assert.deepEqual(categorized.categories["Effect-testing"].map((category) => category.title), ["Testing"])
    const { tree: entry } = await renderMarkdown(await categorized.read("modules/js-ts.md"))
    for (const { title, anchor } of categorized.categories["js-ts"]) assertAnchoredHeading(entry, anchor, title)
    // Grouped symbols stay readable inside their category, and own-page symbols stay linked
    const messages = { type: "root", children: between(entry, "category-messages", "category-other") }
    assert.ok(findAll(messages, isHeading).some((heading) => normalizedText(heading).includes("createClient")))
    assert.ok(linksTo(messages, "interfaces/js-ts.SendOptions/").some((link) => normalizedText(link) === "SendOptions"))
})

test("The task index lists client methods from namespace summaries", async (t) => {
    const { tasks } = await render(t, { categories: false })
    const { tree } = await renderMarkdown(tasks)
    assert.ok(findAll(tree, isHeading).some((heading) => normalizedText(heading) === "client.messages"))
    const task = (target) => {
        const [link] = linksTo(tree, target)
        assert.ok(link, target)
        return { link, row: find(tree, (node) => node.tagName === "tr" && findAll(node, "a").includes(link)) }
    }
    const send = task("interfaces/js-ts.Messages/#send")
    assert.equal(normalizedText(send.link), "client.messages.send")
    // The method's summary sentence describes it in the same task row
    assert.ok(normalizedText(send.row).includes("Send a message to a channel"))
    const connect = task("interfaces/js-ts.Client/#connect")
    assert.equal(normalizedText(connect.link), "client.connect")
    // A first sentence wrapped across source lines stays whole, and later sentences stay out of the row
    assert.ok(normalizedText(connect.row).includes("Connect the gateway and wait until every shard is ready"))
    assert.ok(!normalizedText(connect.row).includes("Later sentences"))
})

test("Re-exported symbols join the category of the declaration they point to", async (t) => {
    const { categories, read } = await render(t, { categories: true, reexport: true })
    // Messages exists on the Effect entry only through the re-export, and no Other category remains
    assert.deepEqual(categories.Effect.map((category) => category.title), ["Messages", "Options"])
    const { tree: entry } = await renderMarkdown(await read("modules/Effect.md"))
    const messages = between(entry, "category-messages", "category-options")
    const reexport = messages.find((node) => node.tagName === "p" && /Re-exports/.test(normalizedText(node)))
    assert.ok(reexport)
    assert.deepEqual(findAll(reexport, "a").map(normalizedText), ["SendOptions"])
    assert.deepEqual(findAll(entry, (node) => node.properties.id === "category-other"), [])
})

test("Testing entry points get their own titled pages and links without joining the task index", async (t) => {
    const { files, read, tasks } = await render(t, { categories: false })
    const paths = files.map((file) => file.path)
    for (const { name, title } of referenceEntries)
        assert.equal((await renderMarkdown(await read(`modules/${name}.md`))).frontmatter.title, title)
    // Same-named interfaces stay separate per entry point
    assert.ok(paths.includes("interfaces/testing.TestClient.md"))
    assert.ok(paths.includes("interfaces/Effect-testing.TestClient.md"))
    assertAnchoredHeading((await renderMarkdown(await read("modules/testing.md"))).tree, "createtestclient", "createTestClient")
    assert.ok(linksTo((await renderMarkdown(await read("interfaces/testing.TestClient.md"))).tree, "interfaces/js-ts.Client/").length > 0)
    // The Effect testing entry re-exports shared fixtures from the default testing page
    const { tree: effectTesting } = await renderMarkdown(await read("modules/Effect-testing.md"))
    const shared = linksTo(effectTesting, "modules/testing/#fixturetoken")
    assert.deepEqual(shared.map(normalizedText), ["fixtureToken"])
    // Only entry points with a Client interface contribute task sections
    const { tree: taskIndex } = await renderMarkdown(tasks)
    assert.ok(findAll(taskIndex, isHeading).some((heading) => normalizedText(heading) === "client.messages"))
    assert.ok(!normalizedText(taskIndex).includes("TestClient"))
    assert.deepEqual(links(taskIndex).filter((link) => /\/modules\/(?:Effect-)?testing\b/.test(href(link))), [])
})

test("Rendering fails when a public entry point is missing and accepts an explicit subset", async (t) => {
    const primary = referenceEntries.slice(0, 2)
    const subset = await render(t, { categories: false, modules: primary })
    assert.deepEqual(Object.keys(subset.categories), primary.map((entry) => entry.name))
    assert.ok(!subset.files.some((file) => /testing/i.test(file.path)))
    await assert.rejects(render(t, { categories: false, modules: [...primary, { ...referenceEntries[2], module: "absent" }] }),
        /Public SDK entry points were not found: absent/)
})
