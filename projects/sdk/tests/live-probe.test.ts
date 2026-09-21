import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const temporaryParent = realpathSync(tmpdir())
const temporaryRoots: string[] = []
const fakeToken = "200.fixture-only-not-a-credential"

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(temporaryParent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture(applicationId = "200") {
    const root = mkdtempSync(join(temporaryParent, "fluxerly-probe-tests-"))
    temporaryRoots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyFileSync(new URL("./live/sandbox.js", import.meta.url), join(root, "tests/live/sandbox.mjs"))
    writeFileSync(
        join(root, ".env.test.local"),
        [
            "FLUXER_TEST_GUILD_ID=100",
            `FLUXER_TEST_APPLICATION_ID=${applicationId}`,
            `FLUXER_TEST_BOT_TOKEN=${fakeToken}`,
        ].join("\n"),
    )
    return root
}

function run(root: string, fetchBody: string) {
    writeFileSync(
        join(root, "boundaries.mjs"),
        `
    globalThis.fetch = async (url) => { console.log("HTTP_ATTEMPT"); ${fetchBody} }
    globalThis.WebSocket = class { constructor() { console.log("SOCKET_ATTEMPT"); throw Error("Forbidden socket") } }
  `,
    )
    const child = spawnSync(process.execPath, ["--import", "./boundaries.mjs", "tests/live/sandbox.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(child.stdout + child.stderr).not.toContain(fakeToken)
    expect(child.stdout).not.toContain("SOCKET_ATTEMPT")
    return child.stdout
}

test("live probe rejects mismatched local application configuration before HTTP", () => {
    const output = run(fixture("201"), "throw Error('Unexpected request')")
    expect(output).toContain('"check":"configured_application"')
    expect(output).not.toContain("HTTP_ATTEMPT")
})

test("live probe leaves an existing run lock untouched without making requests", () => {
    const root = fixture()
    const lock = join(root, ".env.test.local.lock")
    writeFileSync(lock, "fixture-owned-lock")
    const output = run(root, "throw Error('Unexpected request')")
    expect(output).toContain('"check":"sandbox_lock"')
    expect(output).not.toContain("HTTP_ATTEMPT")
    expect(readFileSync(lock, "utf8")).toBe("fixture-owned-lock")
})

test("live probe stops after a mismatched authenticated application response", () => {
    const output = run(fixture(), 'return Response.json({ id: "201" })')
    expect(output).toContain('"check":"application_identity"')
    expect(output.match(/HTTP_ATTEMPT/g)).toHaveLength(1)
})

test("live probe excludes private transport errors from its output", () => {
    const output = run(fixture(), `throw Error(${JSON.stringify(fakeToken)})`)
    expect(output).toContain('"check":"application_identity"')
    expect(output).toContain('"passed":false')
})

test("live probe rejects discovery that would send credentials to another gateway", () => {
    const output = run(
        fixture(),
        `
    const responses = {
      "/v1/applications/@me": { id: "200", bot: { id: "300" } },
      "/v1/users/@me": { id: "300", bot: true },
      "/v1/guilds/100": { id: "100" },
      "/v1/gateway/bot": { url: "wss://example.invalid" },
    }
    return Response.json(responses[new URL(url).pathname])
  `,
    )
    expect(output).toContain('"check":"gateway_endpoint"')
    expect(output.match(/HTTP_ATTEMPT/g)).toHaveLength(4)
})
