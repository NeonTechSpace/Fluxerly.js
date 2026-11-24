/**
 * Shared styling, terminal capability detection, safe line truncation and pixel art for the `fluxerly` CLI.
 * Zero runtime dependencies: Palette tokens match the Fluxerly website, and the mascot sprite is precomputed once
 * from a compact grid so CLI commands stay fast and degrade cleanly across terminals, pipes and classic Windows shells
 */

export type ColorTier = "none" | "ansi16" | "truecolor"

export type Rgb = readonly [red: number, green: number, blue: number]

/** Fluxerly website color tokens in RGB, matched to projects/web/src/styles/global.css */
const cliPalette: Readonly<{
    readonly cyan: Rgb
    readonly cyanLight: Rgb
    readonly violet: Rgb
    readonly gold: Rgb
    readonly success: Rgb
    readonly error: Rgb
    readonly ink: Rgb
    readonly muted: Rgb
    readonly faint: Rgb
    readonly visorDark: Rgb
    readonly visorMid: Rgb
}> = Object.freeze({
    cyan: [70, 227, 239] as const,
    cyanLight: [142, 241, 247] as const,
    violet: [165, 124, 255] as const,
    gold: [236, 196, 110] as const,
    success: [127, 227, 166] as const,
    error: [255, 143, 156] as const,
    ink: [238, 240, 255] as const,
    muted: [195, 200, 230] as const,
    faint: [154, 161, 198] as const,
    visorDark: [7, 10, 38] as const,
    visorMid: [17, 24, 66] as const,
})

// Additional cap shading colors sampled from the mascot artwork for smooth cyan-to-violet cap depth
const spriteColors: Readonly<Record<string, Rgb | null>> = {
    ".": null,
    C: cliPalette.cyan,
    L: [175, 250, 255] as const,
    T: [28, 134, 186] as const,
    B: [24, 82, 162] as const,
    D: [18, 52, 122] as const,
    I: [62, 54, 154] as const,
    P: [118, 66, 198] as const,
    V: cliPalette.violet,
    G: cliPalette.gold,
    N: cliPalette.visorDark,
    M: cliPalette.visorMid,
}

/**
 * 14x14 pixel grid for the Fluxerly conductor bot mascot, packed two pixel rows per terminal row using half blocks:
 * Rows 0-4: Peaked cyan-to-violet conductor's cap with centered gold star, cyan gem and flared brim
 * Rows 5-11: Rounded dark-navy glass screen with glowing cyan eyes, cyan wave and cyan/violet/gold bezel
 * Rows 12-13: Compact horizontal cyan-and-violet bow tie tucked under the rounded chin
 */
const mascotGrid: readonly string[] = [
    "....TTBBIP....",
    "..CTTBBGIPPV..",
    ".CTBBGGGGGIPV.",
    ".CTBBDGLGDIPV.",
    "CTDDDDDDDDDDPV",
    ".CNNNNNNNNNNV.",
    ".CNLLNNNNLLNV.",
    ".CNLLNNNNLLNV.",
    ".CNNNNCCNNNNV.",
    ".CNNNNNNNNNNV.",
    ".CNMMNNNNMMNV.",
    "..CCGGGGGGVV..",
    "...CCCLVVVV...",
    "..............",
]

const reset = "\x1b[0m"
const fgReset = "\x1b[39m"
const bgReset = "\x1b[49m"
const fgRgb = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`
const bgRgb = ([r, g, b]: Rgb) => `\x1b[48;2;${r};${g};${b}m`
const sameRgb = (left: Rgb | null, right: Rgb | null): boolean =>
    left !== null && right !== null && left[0] === right[0] && left[1] === right[1] && left[2] === right[2]

/** Pack a 10x10 pixel grid into 5 half-block terminal lines with transparent corners and scroll-safe resets */
function buildMascotSprite(grid: readonly string[]): readonly string[] {
    const lines: string[] = []
    for (let row = 0; row < grid.length; row += 2) {
        const topRow = grid[row] ?? ""
        const bottomRow = grid[row + 1] ?? ""
        let line = ""
        let activeFg: Rgb | null = null
        let activeBg: Rgb | null = null
        const setColors = (nextFg: Rgb | null, nextBg: Rgb | null) => {
            if (activeBg !== null && nextBg === null) {
                line += bgReset
                activeBg = null
            }
            if (activeFg !== null && nextFg === null) {
                line += fgReset
                activeFg = null
            }
            if (nextFg !== null && !sameRgb(activeFg, nextFg)) {
                line += fgRgb(nextFg)
                activeFg = nextFg
            }
            if (nextBg !== null && !sameRgb(activeBg, nextBg)) {
                line += bgRgb(nextBg)
                activeBg = nextBg
            }
        }
        for (let col = 0; col < topRow.length; col += 1) {
            const top = spriteColors[topRow[col] ?? "."] ?? null
            const bottom = spriteColors[bottomRow[col] ?? "."] ?? null
            if (top === null && bottom === null) {
                setColors(null, null)
                line += " "
            } else if (top !== null && bottom === null) {
                setColors(top, null)
                line += "▀"
            } else if (top === null && bottom !== null) {
                setColors(bottom, null)
                line += "▄"
            } else if (sameRgb(top, bottom)) {
                setColors(top, null)
                line += "█"
            } else {
                setColors(top, bottom)
                line += "▀"
            }
        }
        // Always reset before the line break so scrolling never smears background colors into the next row
        lines.push(`${line}${reset}`)
    }
    return Object.freeze(lines)
}

/** Precomputed 7-row by 14-column mascot sprite lines for 24-bit color Unicode terminals */
export const mascotSpriteLines: readonly string[] = buildMascotSprite(mascotGrid)

export interface CliStreamLike {
    readonly isTTY?: boolean | undefined
    readonly columns?: number | undefined
    readonly rows?: number | undefined
    hasColors?(): boolean
    getColorDepth?(): number
}

export interface CliDetectOptions {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
    readonly platform?: NodeJS.Platform | undefined
    readonly plain?: boolean | undefined
}

export interface CliCapabilities {
    readonly isTTY: boolean
    readonly color: ColorTier
    readonly unicode: boolean
    readonly columns: number
    readonly rows: number
    readonly mascot: boolean
}

const truecolorValuePattern = /^(?:truecolor|24bit)$/i
const truecolorProgramPattern = /^(?:vscode|WezTerm|iTerm\.app|Hyper|mintty)$/i
const windowsUnicodeProgramPattern = /^(?:vscode|WezTerm|mintty|alacritty|hyper)$/i
const asciiLocalePattern = /^(?:C|POSIX)(?:\.(?:ASCII|ANSI_X3\.4-1968))?$/i

/** Minimum terminal dimensions that fit the 7-row mascot beside concise copy without wrapping */
export const mascotMinColumns = 60
export const mascotMinRows = 16

function supportsUnicode(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): boolean {
    if (env.TERM === "dumb") return false
    if (platform === "win32")
        return (
            Boolean(env.WT_SESSION) ||
            Boolean(env.ConEmuTask) ||
            windowsUnicodeProgramPattern.test(env.TERM_PROGRAM ?? "") ||
            truecolorValuePattern.test(env.COLORTERM ?? "") ||
            env.TERM === "xterm-256color"
        )
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
    if (locale && asciiLocalePattern.test(locale)) return false
    return true
}

function detectColorTier(
    stream: CliStreamLike | undefined,
    env: Readonly<Record<string, string | undefined>>,
    isTTY: boolean,
    plain: boolean,
): ColorTier {
    if (plain || !isTTY) return "none"
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none"
    if (env.FORCE_COLOR === "0" || env.TERM === "dumb") return "none"
    const depth = stream?.getColorDepth?.()
    if (
        (depth !== undefined && depth >= 24) ||
        truecolorValuePattern.test(env.COLORTERM ?? "") ||
        Boolean(env.WT_SESSION) ||
        truecolorProgramPattern.test(env.TERM_PROGRAM ?? "")
    )
        return "truecolor"
    if ((depth !== undefined && depth >= 4) || stream?.hasColors?.() === true) return "ansi16"
    return "none"
}

/** Detect terminal color depth, Unicode support, viewport size and mascot eligibility */
export function detectCliCapabilities(
    stream: CliStreamLike | undefined,
    options: CliDetectOptions = {},
): CliCapabilities {
    const env = options.env ?? process.env
    const platform = options.platform ?? process.platform
    const plain = options.plain === true
    const isTTY = stream?.isTTY === true
    const columns = typeof stream?.columns === "number" && stream.columns > 0 ? Math.floor(stream.columns) : 80
    const rows = typeof stream?.rows === "number" && stream.rows > 0 ? Math.floor(stream.rows) : 24
    const color = detectColorTier(stream, env, isTTY, plain)
    const unicode = supportsUnicode(env, platform)
    const mascot = color === "truecolor" && unicode && columns >= mascotMinColumns && rows >= mascotMinRows
    return { isTTY, color, unicode, columns, rows, mascot }
}

// oxlint-disable-next-line no-control-regex -- Matches ANSI CSI escape sequences so visible width and stripping stay exact
const ansiSequencePattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Remove ANSI CSI escape sequences from a string */
export function stripAnsi(text: string): string {
    return text.replace(ansiSequencePattern, "")
}

/** Visible column count of a single CLI line, ignoring ANSI escape sequences */
export function visibleLength(text: string): number {
    const plain = stripAnsi(text)
    let count = 0
    for (let index = 0; index < plain.length;) {
        const codePoint = plain.codePointAt(index)!
        count += 1
        index += codePoint > 0xffff ? 2 : 1
    }
    return count
}

/**
 * Truncate an ANSI-styled line to at most maxColumns visible characters without splitting an escape sequence.
 * Emits a trailing reset whenever styling was active so truncated lines never leak color across redraws
 */
export function truncateVisible(text: string, maxColumns: number, ellipsis = "…"): string {
    if (maxColumns <= 0) return ""
    if (visibleLength(text) <= maxColumns) return text
    const suffix = visibleLength(ellipsis) < maxColumns ? ellipsis : ""
    const budget = maxColumns - visibleLength(suffix)
    let out = ""
    let visible = 0
    let styled = false
    let index = 0
    while (index < text.length && visible < budget) {
        if (text[index] === "\x1b" && text[index + 1] === "[") {
            ansiSequencePattern.lastIndex = index
            const match = ansiSequencePattern.exec(text)
            if (match && match.index === index) {
                out += match[0]
                styled = match[0] !== reset
                index += match[0].length
                continue
            }
        }
        const codePoint = text.codePointAt(index)!
        const char = String.fromCodePoint(codePoint)
        out += char
        visible += 1
        index += char.length
    }
    return `${out}${styled ? reset : ""}${suffix}`
}

export interface CliSymbols {
    readonly brand: string
    readonly pass: string
    readonly warn: string
    readonly fail: string
    readonly pointer: string
    readonly bullet: string
    readonly dash: string
    readonly ellipsis: string
}

export interface CliBannerOptions {
    readonly subtitle?: string | undefined
    readonly version?: string | undefined
    readonly detail?: string | undefined
    readonly hint?: string | undefined
}

export interface CliTheme {
    readonly capabilities: CliCapabilities
    readonly symbols: CliSymbols
    readonly bold: (text: string) => string
    readonly cyan: (text: string) => string
    readonly cyanLight: (text: string) => string
    readonly violet: (text: string) => string
    readonly gold: (text: string) => string
    readonly success: (text: string) => string
    readonly error: (text: string) => string
    readonly ink: (text: string) => string
    readonly muted: (text: string) => string
    readonly faint: (text: string) => string
    readonly fit: (text: string, maxColumns?: number) => string
    readonly renderBanner: (options?: CliBannerOptions) => string
}

const unicodeSymbols: CliSymbols = Object.freeze({
    brand: "≈",
    pass: "✓",
    warn: "!",
    fail: "×",
    pointer: "›",
    bullet: "•",
    dash: "─",
    ellipsis: "…",
})

const asciiSymbols: CliSymbols = Object.freeze({
    brand: "~",
    pass: "+",
    warn: "!",
    fail: "x",
    pointer: ">",
    bullet: "-",
    dash: "-",
    ellipsis: "...",
})

function makeColorizer(tier: ColorTier, rgb: Rgb, ansi16Code: string | null): (text: string) => string {
    if (tier === "none") return (text) => text
    if (tier === "truecolor") {
        const prefix = fgRgb(rgb)
        return (text) => `${prefix}${text}${fgReset}`
    }
    if (ansi16Code === null) return (text) => text
    const end = ansi16Code === "2" ? "\x1b[22m" : fgReset
    return (text) => `\x1b[${ansi16Code}m${text}${end}`
}

/** Build a Fluxerly-branded CLI theme adapted to the target stream's capabilities */
export function createCliTheme(stream: CliStreamLike | undefined, options: CliDetectOptions = {}): CliTheme {
    const capabilities = detectCliCapabilities(stream, options)
    const symbols = capabilities.unicode ? unicodeSymbols : asciiSymbols
    const { color } = capabilities
    const bold = color === "none" ? (text: string) => text : (text: string) => `\x1b[1m${text}\x1b[22m`
    const cyan = makeColorizer(color, cliPalette.cyan, "36")
    const cyanLight = makeColorizer(color, cliPalette.cyanLight, "96")
    const violet = makeColorizer(color, cliPalette.violet, "35")
    const gold = makeColorizer(color, cliPalette.gold, "33")
    const success = makeColorizer(color, cliPalette.success, "32")
    const error = makeColorizer(color, cliPalette.error, "31")
    const ink = (text: string) => text
    const muted = color === "none" ? (text: string) => text : (text: string) => `\x1b[2m${text}\x1b[22m`
    const faint = muted

    const fit = (text: string, maxColumns = Math.max(20, capabilities.columns - 1)) =>
        truncateVisible(text, maxColumns, symbols.ellipsis)

    const renderBanner = (banner: CliBannerOptions = {}): string => {
        if (capabilities.color === "none") return ""
        const versionTag = banner.version ? ` v${banner.version}` : ""
        const subtitle = banner.subtitle ?? "Fluxer-native bot SDK"
        const maxWidth = Math.max(20, capabilities.columns - 1)
        if (!capabilities.mascot) {
            const compact = `${cyan(symbols.brand)} ${bold(cyan("Fluxerly"))}${faint(versionTag)}${subtitle ? `  ${faint(subtitle)}` : ""}`
            return `${fit(compact, maxWidth)}${reset}\n`
        }
        const textBudget = Math.max(12, maxWidth - 16)
        const ruleWidth = Math.min(28, textBudget)
        const rightLines = [
            "",
            `${bold(cyan("Fluxerly"))}${faint(versionTag)}`,
            muted(subtitle),
            faint(symbols.dash.repeat(ruleWidth)),
            banner.detail ? cyanLight(banner.detail) : faint("Node.js 26+  JavaScript  TypeScript  Effect"),
            faint(banner.hint ?? "https://fluxerly.neontechspace.com"),
            "",
        ]
        return `${mascotSpriteLines
            .map((sprite, index) => {
                const copy = rightLines[index]
                const suffix = copy ? `  ${fit(copy, textBudget)}` : ""
                return `${sprite}${suffix}${reset}`
            })
            .join("\n")}\n`
    }

    return {
        capabilities,
        symbols,
        bold,
        cyan,
        cyanLight,
        violet,
        gold,
        success,
        error,
        ink,
        muted,
        faint,
        fit,
        renderBanner,
    }
}
