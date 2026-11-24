import { describe, expect, test } from "vitest"
import {
    createCliTheme,
    detectCliCapabilities,
    mascotMinColumns,
    mascotMinRows,
    mascotSpriteLines,
    stripAnsi,
    truncateVisible,
    visibleLength,
    type CliStreamLike,
} from "../../src/internal/cli-theme.js"

// oxlint-disable-next-line no-control-regex -- Verifies stripped output contains no ANSI escape sequences
const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/

function tty(overrides: Partial<CliStreamLike> = {}): CliStreamLike {
    return {
        isTTY: true,
        columns: 80,
        rows: 24,
        hasColors: () => true,
        getColorDepth: () => 24,
        ...overrides,
    }
}

describe("cli-theme terminal capabilities and safe fallbacks", () => {
    test("piped streams, NO_COLOR, FORCE_COLOR=0, TERM=dumb and plain mode emit zero ANSI escapes or banners", () => {
        const cases = [
            { stream: { isTTY: false, columns: 100, rows: 40 }, env: { COLORTERM: "truecolor" } },
            { stream: tty(), env: { COLORTERM: "truecolor", NO_COLOR: "1" } },
            { stream: tty(), env: { COLORTERM: "truecolor", FORCE_COLOR: "0" } },
            { stream: tty(), env: { TERM: "dumb" } },
            { stream: tty(), env: { COLORTERM: "truecolor" }, plain: true },
        ]
        for (const item of cases) {
            const caps = detectCliCapabilities(item.stream, { env: item.env, platform: "linux", plain: item.plain })
            expect(caps.color).toBe("none")
            expect(caps.mascot).toBe(false)
            const theme = createCliTheme(item.stream, { env: item.env, platform: "linux", plain: item.plain })
            expect(theme.renderBanner({ version: "1003.0.0" })).toBe("")
            expect(theme.cyan("hello")).toBe("hello")
            expect(theme.error("oops")).toBe("oops")
        }
    })

    test("adapts color depth, Unicode symbols and ASCII fallbacks across terminals and locales", () => {
        // Truecolor detection across common terminal env variables
        for (const env of [{ COLORTERM: "truecolor" }, { WT_SESSION: "wt-1" }, { TERM_PROGRAM: "vscode" }]) {
            const caps = detectCliCapabilities({ isTTY: true, columns: 80, rows: 24 }, { env, platform: "linux" })
            expect(caps.color).toBe("truecolor")
            expect(caps.mascot).toBe(true)
        }

        // 16-color terminals fall back to a compact single-line header
        const ansi16 = createCliTheme(
            { isTTY: true, columns: 80, rows: 24, hasColors: () => true, getColorDepth: () => 4 },
            { env: {}, platform: "linux" },
        )
        expect(ansi16.capabilities.color).toBe("ansi16")
        expect(ansi16.capabilities.mascot).toBe(false)
        const compact = ansi16.renderBanner({ version: "1003.0.0", subtitle: "Offline check" })
        expect(compact.trimEnd().split("\n")).toHaveLength(1)
        expect(compact.endsWith("\x1b[0m\n")).toBe(true)

        // Classic Windows PowerShell and C/POSIX locales stick to ASCII symbols; Windows Terminal and C.UTF-8 enable Unicode
        const conhost = createCliTheme(
            { isTTY: true, columns: 80, rows: 24, hasColors: () => true, getColorDepth: () => 4 },
            { env: {}, platform: "win32" },
        )
        expect(conhost.capabilities.unicode).toBe(false)
        expect(stripAnsi(conhost.renderBanner({ version: "1003.0.0" }))).not.toMatch(/[≈✓×›▀▄█─…]/)
        expect(
            detectCliCapabilities(
                { isTTY: true, columns: 80, rows: 24 },
                { env: { WT_SESSION: "wt-1" }, platform: "win32" },
            ),
        ).toMatchObject({ unicode: true, color: "truecolor", mascot: true })
        expect(detectCliCapabilities(tty(), { env: { LC_ALL: "C" }, platform: "linux" }).unicode).toBe(false)
        expect(detectCliCapabilities(tty(), { env: { LC_ALL: "C.UTF-8" }, platform: "linux" }).unicode).toBe(true)
    })

    test("mascot banner respects terminal bounds, resets ANSI per row and never clears scrollback", () => {
        const narrow = createCliTheme(tty({ columns: mascotMinColumns - 1, rows: 24 }), { env: {}, platform: "linux" })
        expect(narrow.capabilities.mascot).toBe(false)
        const narrowLine = narrow.renderBanner({ version: "1003.0.0", subtitle: "Starter bot setup" }).trimEnd()
        expect(narrowLine.split("\n")).toHaveLength(1)
        expect(visibleLength(narrowLine)).toBeLessThanOrEqual(mascotMinColumns - 2)

        expect(
            detectCliCapabilities(tty({ columns: 80, rows: mascotMinRows - 1 }), { env: {}, platform: "linux" }).mascot,
        ).toBe(false)

        const exact = createCliTheme(tty({ columns: mascotMinColumns, rows: mascotMinRows }), {
            env: {},
            platform: "linux",
        })
        expect(exact.capabilities.mascot).toBe(true)
        const banner = exact.renderBanner({
            version: "1003.0.0",
            subtitle: "Fluxer-native bot SDK",
            detail: "/very/long/project/path/that/must/truncate/cleanly/without/wrapping/anywhere",
        })
        const rows = banner.trimEnd().split("\n")
        expect(rows).toHaveLength(mascotSpriteLines.length)
        for (const row of rows) {
            expect(row.endsWith("\x1b[0m")).toBe(true)
            expect(visibleLength(row)).toBeLessThanOrEqual(mascotMinColumns - 1)
        }
        // Uniform sprite width and scroll-safe output (no clear-screen or alt-screen escapes)
        const spriteWidths = new Set(mascotSpriteLines.map((line) => visibleLength(line)))
        expect(spriteWidths.size).toBe(1)
        expect(banner).not.toContain("\x1b[2J")
        expect(banner).not.toContain("\x1b[?1049h")
    })

    test("truncateVisible fits ANSI-styled lines within maxColumns without splitting escape sequences", () => {
        const theme = createCliTheme(tty(), { env: {}, platform: "linux" })
        const styled = `${theme.cyan("› Effect")}  ${theme.muted("TypeScript with the native Effect API")}`
        const cut = truncateVisible(styled, 24, "…")
        expect(visibleLength(cut)).toBeLessThanOrEqual(24)
        expect(stripAnsi(cut).endsWith("…")).toBe(true)
        expect(cut).toContain("\x1b[0m")
        expect(stripAnsi(cut)).not.toMatch(ansiPattern)
        expect(truncateVisible(theme.cyan("short"), 20, "…")).toBe(theme.cyan("short"))
        expect(truncateVisible(styled, 0, "…")).toBe("")
    })
})
