import { seams } from "../../scripts/docs/code-breaks.mjs"
import { tokenize, type Language, type Token, type TokenKind } from "./highlight"

// Where a code line may turn when it is longer than its block: at a space, or before a dot or after a slash. The seams are
// read on the whole line, so one between two tokens counts too. Everything between two seams holds together, so a line
// never turns inside a name, and a package's name stays whole

export interface Piece {
    text: string
    kind: TokenKind
    // A run of spaces, which is where a line turns first
    space: boolean
    // A turn may come right before this piece
    seam: boolean
}

export function codePieces(line: string, tokens: Token[]): Piece[] {
    const points = new Set(seams(line, { block: true }))
    const pieces: Piece[] = []
    let offset = 0
    for (const token of tokens) {
        for (const run of token.text.split(/(\s+)/)) {
            if (!run) continue
            if (/^\s+$/.test(run)) {
                pieces.push({ text: run, kind: token.kind, space: true, seam: false })
                offset += run.length
                continue
            }
            let start = 0
            for (let at = 1; at < run.length; at++) {
                if (!points.has(offset + at)) continue
                pieces.push({ text: run.slice(start, at), kind: token.kind, space: false, seam: start > 0 || points.has(offset) })
                start = at
            }
            pieces.push({ text: run.slice(start), kind: token.kind, space: false, seam: start > 0 || points.has(offset) })
            offset += run.length
        }
    }
    return pieces
}

// Every line of a block as its pieces, colored for the block's language
export function codeLines(code: string, language: Language = "js"): Piece[][] {
    const raw = code.replace(/\n$/, "").split("\n")
    const tokens = tokenize(code, language)
    return raw.map((line, index) => codePieces(line, tokens[index]!))
}

// The line's own indent in characters, which the turned part of a wrapped line hangs past. A tab counts as the
// block's tab size
export function codeIndent(line: string): number {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? ""
    return lead.replace(/\t/g, "    ").length
}

// The indent as the line's style, for the block's hanging indent
export function codeIndentStyle(line: string): string | undefined {
    const width = codeIndent(line)
    return width > 0 ? `--indent: ${width}ch` : undefined
}
