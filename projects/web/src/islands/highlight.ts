// Light syntax coloring for the short samples on the homepage and the feature pages. JavaScript and TypeScript get
// comments, strings, numbers, keywords and calls, which is all those samples need. The small files beside them have
// their own few shapes: a .env file is keys, equals signs and values, an ignore file is paths with glob marks, a
// shell line is assignments then a command, and a unit file is sections, keys and values

export type TokenKind = "plain" | "keyword" | "string" | "call" | "comment" | "number" | "key" | "op" | "section"
export type Language = "js" | "dotenv" | "gitignore" | "sh" | "ini" | "text"

export interface Token {
    kind: TokenKind
    text: string
}

const keywords = new Set([
    "as",
    "async",
    "await",
    "const",
    "else",
    "export",
    "false",
    "from",
    "function",
    "if",
    "import",
    "let",
    "new",
    "null",
    "return",
    "throw",
    "true",
    "type",
    "undefined",
    "using",
    "yield",
])

const pattern = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*\b)|([A-Za-z_$][\w$]*)(?=(\s*\()?)/g

// Collects tokens, joining neighbours of one kind
function collector() {
    const tokens: Token[] = []
    const push = (kind: TokenKind, text: string) => {
        if (!text) return
        const previous = tokens[tokens.length - 1]
        if (previous && previous.kind === kind) previous.text += text
        else tokens.push({ kind, text })
    }
    return { tokens, push }
}

function tokenizeScript(line: string): Token[] {
    const { tokens, push } = collector()
    let last = 0
    for (const match of line.matchAll(pattern)) {
        const index = match.index ?? 0
        push("plain", line.slice(last, index))
        const [text, comment, string, number, word, call] = match
        if (comment) push("comment", text)
        else if (string) push("string", text)
        else if (number) push("number", text)
        else if (word && keywords.has(word)) push("keyword", text)
        else if (word && call !== undefined) push("call", text)
        else push("plain", text)
        last = index + text.length
    }
    push("plain", line.slice(last))
    return tokens
}

// A value after an equals sign: quoted or bare it is a string, a whole number is a number
function pushValue(push: (kind: TokenKind, text: string) => void, value: string) {
    if (!value) return
    if (/^\d+$/.test(value.trim())) push("number", value)
    else push("string", value)
}

function tokenizeEnv(line: string): Token[] {
    const { tokens, push } = collector()
    const comment = /^(\s*)(#.*)$/.exec(line)
    const pair = /^(\s*)((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line)
    if (comment) {
        push("plain", comment[1]!)
        push("comment", comment[2]!)
    } else if (pair) {
        push("plain", pair[1]!)
        push("keyword", pair[2]!)
        push("key", pair[3]!)
        push("op", pair[4]!)
        pushValue(push, pair[5]!)
    } else push("plain", line)
    return tokens
}

function tokenizeIgnore(line: string): Token[] {
    const { tokens, push } = collector()
    if (/^\s*#/.test(line)) {
        push("comment", line)
        return tokens
    }
    for (const match of line.matchAll(/(^!)|(\*\*?|\?)|(\[[^\]]*\])|(\/)|([^!*?[/]+)/g)) {
        const [text, negation, glob, charClass, slash] = match
        if (negation || glob) push("keyword", text)
        else if (charClass) push("number", text)
        else if (slash) push("op", text)
        else push("string", text)
    }
    return tokens
}

function tokenizeShell(line: string): Token[] {
    const { tokens, push } = collector()
    const comment = /^(\s*)(#.*)$/.exec(line)
    if (comment) {
        push("plain", comment[1]!)
        push("comment", comment[2]!)
        return tokens
    }
    let rest = line
    const lead = /^\s*/.exec(rest)![0]
    push("plain", lead)
    rest = rest.slice(lead.length)
    // Assignments before the command, such as FLUXERLY_DEBUG=rest,ratelimit
    let assignment: RegExpExecArray | null
    while ((assignment = /^([A-Za-z_][A-Za-z0-9_]*)(=)(\S*)(\s+)/.exec(rest))) {
        push("key", assignment[1]!)
        push("op", assignment[2]!)
        pushValue(push, assignment[3]!)
        push("plain", assignment[4]!)
        rest = rest.slice(assignment[0].length)
    }
    const command = /^(\S+)/.exec(rest)
    if (command) {
        push("call", command[1]!)
        rest = rest.slice(command[1]!.length)
    }
    for (const match of rest.matchAll(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([^"']+)/g)) {
        const [text, string] = match
        push(string ? "string" : "plain", text)
    }
    return tokens
}

function tokenizeIni(line: string): Token[] {
    const { tokens, push } = collector()
    const comment = /^(\s*)([#;].*)$/.exec(line)
    const section = /^(\s*)(\[[^\]]*\])(\s*)$/.exec(line)
    const pair = /^(\s*)([^=\s]+)(\s*=\s*)(.*)$/.exec(line)
    if (comment) {
        push("plain", comment[1]!)
        push("comment", comment[2]!)
    } else if (section) {
        push("plain", section[1]!)
        push("section", section[2]!)
        push("plain", section[3]!)
    } else if (pair) {
        push("plain", pair[1]!)
        push("call", pair[2]!)
        push("op", pair[3]!)
        push("plain", pair[4]!)
    } else push("plain", line)
    return tokens
}

export function tokenizeLine(line: string, language: Language = "js"): Token[] {
    switch (language) {
        case "dotenv":
            return tokenizeEnv(line)
        case "gitignore":
            return tokenizeIgnore(line)
        case "sh":
            return tokenizeShell(line)
        case "ini":
            return tokenizeIni(line)
        case "text":
            return [{ kind: "plain", text: line }]
        default:
            return tokenizeScript(line)
    }
}

export function tokenize(code: string, language: Language = "js"): Token[][] {
    return code
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => tokenizeLine(line, language))
}
