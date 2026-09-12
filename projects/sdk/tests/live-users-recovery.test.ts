import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"

const parent = realpathSync(tmpdir())
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) {
        const target = realpathSync(root)
        expect(dirname(target)).toBe(parent)
        expect(resolve(target)).toBe(resolve(root))
        rmSync(target, { recursive: true })
    }
})

function fixture() {
    const root = mkdtempSync(join(parent, "fluxerly-users-live-"))
    roots.push(root)
    mkdirSync(join(root, "tests/live"), { recursive: true })
    copyFileSync(join(sdkRoot, "tests/live/users.mjs"), join(root, "tests/live/users.mjs"))
    copyFileSync(join(sdkRoot, "tests/live/sdk.mjs"), join(root, "tests/live/sdk.mjs"))
    mkdirSync(join(root, "node_modules"))
    for (const dependency of ["effect", "ws"])
        symlinkSync(join(sdkRoot, "node_modules", dependency), join(root, "node_modules", dependency), "junction")
    writeFileSync(
        join(root, ".env.test.local"),
        [
            "FLUXER_TEST_GUILD_ID=100",
            "FLUXER_TEST_APPLICATION_ID=200",
            "FLUXER_TEST_BOT_TOKEN=fixture-not-a-credential",
            "FLUXER_TEST_DM_USER_ID=499",
            "FLUXER_TEST_GROUP_DM_ID=599",
            "FLUXER_TEST_GROUP_EXTRA_USER_ID=600",
        ].join("\n"),
    )
    writeFileSync(
        join(root, "trap.mjs"),
        'globalThis.fetch = () => { console.log("HTTP_ATTEMPT"); throw Error("Forbidden request") }',
    )
    return root
}

function run(
    root: string,
    script: "users.mjs" | "sdk.mjs",
    args: string[],
    environment: Record<string, string | undefined> = {},
) {
    const env = { ...process.env, ...environment }
    for (const name of ["FLUXER_TEST_DM_USER_ID", "FLUXER_TEST_GROUP_DM_ID", "FLUXER_TEST_GROUP_EXTRA_USER_ID"])
        if (!(name in environment)) delete env[name]
    return spawnSync(process.execPath, ["--import", "./trap.mjs", `tests/live/${script}`, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
}

function expectNoHttp(result: ReturnType<typeof run>) {
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).not.toContain("HTTP_ATTEMPT")
    expect(output).not.toContain("fixture-not-a-credential")
    return output
}

test("users live script rejects missing or invalid process-only selections before HTTP", () => {
    const root = fixture()
    expect(expectNoHttp(run(root, "users.mjs", ["default"]))).toContain("DM recipient")
    expect(expectNoHttp(run(root, "users.mjs", ["default"], { FLUXER_TEST_DM_USER_ID: "invalid" }))).toContain(
        "DM recipient",
    )
    expect(
        expectNoHttp(
            run(root, "users.mjs", ["default"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_DM_ID: "invalid",
            }),
        ),
    ).toContain("group ID")
    expect(
        expectNoHttp(
            run(root, "users.mjs", ["default"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_EXTRA_USER_ID: "invalid",
            }),
        ),
    ).toContain("group participant")
})

test("users live script ignores stored participant selections and preserves another lock", () => {
    const root = fixture()
    writeFileSync(
        join(root, ".env.test.local"),
        "FLUXER_TEST_GUILD_ID=100\nFLUXER_TEST_APPLICATION_ID=200\nFLUXER_TEST_BOT_TOKEN=fixture-not-a-credential\nFLUXER_TEST_DM_USER_ID=499\nFLUXER_TEST_GROUP_DM_ID=stale-group\nFLUXER_TEST_GROUP_EXTRA_USER_ID=stale-extra\n",
    )
    writeFileSync(join(root, ".env.test.local.lock"), "another-run")
    const output = expectNoHttp(run(root, "users.mjs", ["default"], { FLUXER_TEST_DM_USER_ID: "400" }))
    expect(output).toContain('"stage":"configuration"')
    expect(readFileSync(join(root, ".env.test.local.lock"), "utf8")).toBe("another-run")
})

test("quality SDK script rejects process-only targets before identity HTTP", () => {
    const root = fixture()
    expect(expectNoHttp(run(root, "sdk.mjs", ["default", "--quality"]))).toContain("quality user")
    expect(
        expectNoHttp(
            run(root, "sdk.mjs", ["default", "--quality"], {
                FLUXER_TEST_DM_USER_ID: "400",
                FLUXER_TEST_GROUP_DM_ID: "invalid",
            }),
        ),
    ).toContain("quality group")
})
