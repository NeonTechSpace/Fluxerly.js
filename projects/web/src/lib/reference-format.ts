// Prints reference types and signatures as highlighted HTML that fits a column, the way a code formatter would. A type
// stays on one line when it fits. Otherwise only the outermost construct that does not fit breaks: a list puts one item
// on each line, or fills its lines when the items are plain names, a union or intersection puts each member on a line
// of its own after a leading | or &, and a function type keeps its parameters together and moves its result to the
// next line. Pages print each type at two widths, one for wide columns and one for phones, and the styles show the one
// that fits
import { leavesSite } from "./external-links.mjs"
import type { Member, ObjectType, Parameter, Signature, Type, TypeParameter } from "./reference"

interface Token {
    s: string
    /** k keyword, l literal, n declared name, p parameter or member name, t type name */
    c?: "k" | "l" | "n" | "p" | "t"
    h?: string
}

// A seq group joins its items with spaces, or breaks before each item after the first, indented. A name's seq may
// instead keep its type on the name's line and let the type break, when moving the type down would not make it fit.
// A fn group holds a function type's parameters, with its type parameters, and its result
interface Group {
    mode: "list" | "object" | "union" | "and" | "cond" | "seq" | "fn"
    open: string
    close: string
    items: Piece[][]
    hug?: boolean
}

type Piece = Token | Group

const isGroup = (piece: Piece): piece is Group => "items" in piece
const seq = (items: Piece[][]): Group => ({ mode: "seq", open: "", close: "", items })
const text = (s: string, c?: Token["c"], h?: string): Token => ({ s, ...(c ? { c } : {}), ...(h ? { h } : {}) })

// Types to pieces

const keywordLike = /^[a-z]+$/

function typePieces(type: Type): Piece[] {
    if (typeof type === "string") return [text(type, keywordLike.test(type) && type !== "true" && type !== "false" && type !== "null" ? "k" : "l")]
    if ("r" in type) {
        const name = text(type.r, "t", type.h)
        return type.a?.length ? [name, { mode: "list", open: "<", close: ">", items: type.a.map(typePieces) }] : [name]
    }
    switch (type.k) {
        case "union":
        case "and": {
            const within = type.k
            return [{ mode: within, open: "", close: "", items: type.t.map((member) => wrapped(member, within)) }]
        }
        case "arr":
            return [...wrapped(type.t), text("[]")]
        case "tuple":
            return [{ mode: "list", open: "[", close: "]", items: type.t.map(typePieces) }]
        case "named":
            return [text(type.n, "p"), text(type.o ? "?: " : ": "), ...typePieces(type.t)]
        case "optional":
            return [...wrapped(type.t), text("?")]
        case "rest":
            return [text("..."), ...typePieces(type.t)]
        case "query":
            return [text("typeof ", "k"), ...typePieces(type.t)]
        case "op":
            return [text(`${type.op} `, "k"), ...wrapped(type.t, "op")]
        case "idx":
            return [...wrapped(type.o), { mode: "list", open: "[", close: "]", items: [typePieces(type.i)] }]
        case "cond":
            return [{ mode: "cond", open: "", close: "", items: [[...typePieces(type.c), text(" extends ", "k"), ...typePieces(type.e)], typePieces(type.y), typePieces(type.f)] }]
        case "mapped": {
            const readonly = type.ro ? [text(type.ro === "-" ? "-readonly " : "readonly ", "k")] : []
            const optional = type.opt ? (type.opt === "-" ? "-?" : "?") : ""
            const rename = type.as ? [text(" as ", "k"), ...typePieces(type.as)] : []
            const key = [...readonly, text("["), text(type.p, "p"), text(" in ", "k"), ...typePieces(type.c), ...rename, text(`]${optional}:`)]
            return [{ mode: "object", open: "{", close: "}", items: [[seq([key, typePieces(type.t)])]] }]
        }
        case "infer":
            return [text("infer ", "k"), text(type.n, "t"), ...(type.c ? [text(" extends ", "k"), ...typePieces(type.c)] : [])]
        case "pred":
            return [...(type.as ? [text("asserts ", "k")] : []), text(type.n, "p"), ...(type.t ? [text(" is ", "k"), ...typePieces(type.t)] : [])]
        case "tpl":
            return [text("`" + type.h, "l"), ...type.tail.flatMap(([inner, after]) => [text("${"), ...typePieces(inner), text("}"), text(after, "l")]), text("`", "l")]
        case "raw":
            return [text(type.s)]
        case "obj":
            return objectPieces(type)
    }
}

// Parentheses only where the grammar needs them. An intersection binds tighter than a union, so it needs none inside
// one. Conditionals and function types need them inside unions and intersections, and every loose type needs them
// inside operators. Before a [] or ? that follows the type, an inferred type and an operator such as keyof need them
// too, so an array of inferred elements prints as readonly (infer Each)[] and keyof X[] stays the keys of an array
function wrapped(type: Type, within?: "union" | "and" | "op"): Piece[] {
    const pieces = typePieces(type)
    const kind = typeof type === "object" && "k" in type ? type.k : undefined
    const functionType = kind === "obj" && isFunctionType(type as ObjectType)
    const operand = kind === "union" || kind === "and" || kind === "cond" || functionType
    const loose =
        within === "union" ? kind === "cond" || functionType : within === "and" ? kind === "union" || kind === "cond" || functionType : within === "op" ? operand : operand || kind === "infer" || kind === "op"
    return loose ? [text("("), ...pieces, text(")")] : pieces
}

const isFunctionType = (type: ObjectType) => type.s?.length === 1 && !type.m?.length && !type.x?.length

function objectPieces(type: ObjectType): Piece[] {
    if (isFunctionType(type)) {
        const signature = type.s![0]!
        return [{ mode: "fn", open: "", close: "", items: [[...typeParameterPieces(signature.tp), parameterGroup(signature.p)], typePieces(signature.r)] }]
    }
    const items: Piece[][] = [
        ...(type.x ?? []).map((index) => [
            ...(index.r ? [text("readonly ", "k")] : []),
            text("["),
            text(index.n, "p"),
            text(": "),
            ...typePieces(index.kt),
            text("]: "),
            ...typePieces(index.t),
        ]),
        ...(type.s ?? []).map((signature) => signaturePieces(signature)),
        ...(type.m ?? []).flatMap((member) => memberPieces(member)),
    ]
    // An object whose members are listed below its declaration
    if (!items.length) return [text("{ … }")]
    return [{ mode: "object", open: "{", close: "}", items }]
}

// A name and its type. A type that breaks itself, such as an object, a union or a function type, follows the name on its
// line. Any other type moves below the name when the line is too long
function named(head: Piece[], body: Piece[]): Piece[] {
    const first = body[0]
    const hugs = body.length === 1 && first !== undefined && isGroup(first) && first.mode !== "list"
    return hugs ? [...head, text(" "), ...body] : [{ ...seq([head, body]), hug: true }]
}

function memberPieces(member: Member): Piece[][] {
    if (member.signatures?.length) return member.signatures.map((signature) => signaturePieces(signature, member.name))
    return [named([...(member.readonly ? [text("readonly ", "k")] : []), text(member.name, "p"), text(member.optional ? "?:" : ":")], typePieces(member.type ?? "unknown"))]
}

function parameterPieces(parameter: Parameter): Piece[] {
    return named(
        [...(parameter.r ? [text("...")] : []), text(parameter.n, "p"), text(parameter.o && !parameter.dv ? "?:" : ":")],
        [...typePieces(parameter.t), ...(parameter.dv ? [text(" = "), text(parameter.dv, "l")] : [])],
    )
}

const parameterGroup = (parameters: Parameter[]): Group => ({ mode: "list", open: "(", close: ")", items: parameters.map(parameterPieces) })

function typeParameterPieces(parameters: TypeParameter[] | undefined): Piece[] {
    if (!parameters?.length) return []
    return [{
        mode: "list",
        open: "<",
        close: ">",
        items: parameters.map((parameter) => {
            const head = [text(parameter.n, "t"), ...(parameter.c ? [text(" extends ", "k"), ...typePieces(parameter.c)] : [])]
            return parameter.d ? [seq([head, [text("= "), ...typePieces(parameter.d)]])] : head
        }),
    }]
}

function signaturePieces(signature: Signature, name?: string, prefix: Piece[] = []): Piece[] {
    return [...prefix, ...(name ? [text(name, "n")] : []), ...typeParameterPieces(signature.tp), parameterGroup(signature.p), text(": "), ...typePieces(signature.r)]
}

// Layout

function flatWidth(pieces: Piece[]): number {
    let width = 0
    for (const piece of pieces) {
        if (!isGroup(piece)) {
            width += piece.s.length
            continue
        }
        const items = piece.items.map(flatWidth)
        const sum = items.reduce((total, item) => total + item, 0)
        const gaps = Math.max(0, items.length - 1)
        switch (piece.mode) {
            case "union":
            case "and":
                width += sum + gaps * 3
                break
            case "seq":
                width += sum + gaps
                break
            case "cond":
                width += sum + 6
                break
            case "fn":
                width += sum + 4
                break
            case "object":
                width += sum + gaps * 2 + 4
                break
            case "list":
                width += sum + gaps * 2 + piece.open.length + piece.close.length
        }
    }
    return width
}

// A single name or literal, which never breaks
const plain = (item: Piece[]) => item.length === 1 && !isGroup(item[0]!)

// Type arguments this short share their lines
const shortArgument = 20

// The width of what follows up to its first chance to break: its text, up to and including the next group's opening.
// When nothing in it can break, all of it and the enclosing construct's own tail
function untilBreak(pieces: Piece[], tail: number): number {
    let width = 0
    for (const piece of pieces) {
        if (!isGroup(piece)) width += piece.s.length
        else if (piece.mode === "list" || piece.mode === "object") return width + piece.open.length
        else return width
    }
    return width + tail
}

// Lists this narrow do not break, as breaking them would not shorten the line by much. Their line may run a few
// characters past the limit instead, but no more than smallOverrun, so a long line breaks the list as any other
const smallList = 16
const smallOverrun = 4

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

function tokenHtml(token: Token): string {
    const body = escape(token.s)
    if (token.h) {
        // A link that leaves the site opens in a new tab, as everywhere on the site
        const external = leavesSite(token.h)
        return `<a class="ty-${token.c ?? "t"}" href="${escape(token.h)}"${external ? ' target="_blank" rel="noopener external"' : ""}>${body}</a>`
    }
    return token.c ? `<span class="ty-${token.c}">${body}</span>` : body
}

class Printer {
    html = ""
    column = 0
    lineStart = true
    /** Right after a union or intersection member's leading operator */
    afterOperator = false
    readonly width: number
    /** Indent of a broken group: four spaces, or two in a phone's narrow column */
    readonly step: number
    constructor(width: number) {
        this.width = width
        this.step = width < 50 ? 2 : 4
    }

    write(value: string, token?: Token) {
        this.html += token ? tokenHtml(token) : escape(value)
        this.column += value.length
        this.lineStart = false
        this.afterOperator = false
    }

    newline(indent: number) {
        this.html = this.html.replace(/ +(<\/span>)?$/, "$1") + "\n" + " ".repeat(indent)
        this.column = indent
        this.lineStart = true
        this.afterOperator = false
    }

    operator(value: string) {
        this.write(value)
        this.afterOperator = true
    }

    fits(width: number) {
        return this.column + width <= this.width
    }

    /** Prints a sequence. The tail is the width that has to follow it on the same line, up to the enclosing construct's
     * next break */
    print(pieces: Piece[], indent: number, tail = 0) {
        pieces.forEach((piece, index) => {
            if (!isGroup(piece)) return this.write(piece.s, piece)
            const rest = pieces.slice(index + 1)
            const restWidth = flatWidth(rest) + tail
            this.group(piece, indent, this.staysFlat(piece, rest, indent, tail), restWidth)
        })
    }

    // Outermost first. A group stays on one line when it and the rest of the line fit. When only the rest is too long,
    // the group breaks if the rest then fits after its last line, and otherwise stays whole so the rest breaks instead
    staysFlat(group: Group, rest: Piece[], indent: number, tail: number): boolean {
        const width = flatWidth([group])
        const restWidth = flatWidth(rest) + tail
        if (this.fits(width + restWidth)) return true
        if (group.mode === "list" && width <= smallList && this.column + width + untilBreak(rest, tail) <= this.width + smallOverrun) return true
        if (!this.fits(width + untilBreak(rest, tail))) return false
        return lastLine(group, indent, this.lineStart ? this.column : indent + this.step, this.step) + restWidth > this.width
    }

    group(group: Group, indent: number, flat: boolean, tail: number) {
        const inner = indent + this.step
        const last = group.items.length - 1
        switch (group.mode) {
            case "union":
            case "and": {
                const operator = group.mode === "union" ? "| " : "& "
                if (flat) return group.items.forEach((item, index) => (index && this.write(` ${operator}`), this.print(item, indent, index === last ? tail : 0)))
                // Each member on a line of its own after a leading operator, at the indent of a line the group starts.
                // A group that is itself a member of an outer one starts right after the outer operator, without its own
                const nested = this.afterOperator
                const level = this.lineStart || nested ? this.column : inner
                if (!this.lineStart && !nested) this.newline(level)
                // Members that are plain names or literals fill each line instead
                if (group.items.every(plain)) {
                    return group.items.forEach((item, index) => {
                        const width = flatWidth(item) + (index === last ? tail : 0)
                        if (index && this.column + 3 + width > this.width) this.newline(level)
                        else if (index) this.write(" ")
                        if (index || !nested) this.operator(operator)
                        this.print(item, level + 2)
                    })
                }
                return group.items.forEach((item, index) => {
                    if (index) this.newline(level)
                    if (index || !nested) this.operator(operator)
                    this.print(item, level + 2, index === last ? tail : 0)
                })
            }
            case "fn": {
                const [head = [], result = []] = group.items
                if (flat) {
                    this.print(head, indent)
                    this.write(" => ")
                    return this.print(result, indent, tail)
                }
                // The parameters stay together on this line when they fit, and the result moves to the next one
                if (this.fits(flatWidth(head))) {
                    this.print(head, indent, 0)
                    this.newline(inner)
                    this.write("=> ")
                    return this.print(result, inner, tail)
                }
                this.print(head, indent, 4 + flatWidth(result) + tail)
                this.write(" => ")
                return this.print(result, indent, tail)
            }
            case "cond": {
                const [check = [], yes = [], no = []] = group.items
                if (flat) {
                    this.print(check, indent)
                    this.write(" ? ")
                    this.print(yes, indent)
                    this.write(" : ")
                    return this.print(no, indent, tail)
                }
                this.print(check, indent)
                this.newline(inner)
                this.write("? ")
                this.print(yes, inner + 2)
                this.newline(inner)
                this.write(": ")
                // A chain of conditionals stays at one indent
                const chained = no.length === 1 && isGroup(no[0]!) && no[0].mode === "cond"
                return this.print(no, chained ? indent : inner + 2, tail)
            }
            case "seq":
                // A name keeps a type that would not fit below it either on its own line, and the type breaks there
                if (!flat && group.hug && inner + flatWidth(group.items[1] ?? []) + tail > this.width) {
                    this.print(group.items[0] ?? [], indent)
                    this.write(" ")
                    return this.print(group.items[1] ?? [], indent, tail)
                }
                return group.items.forEach((item, index) => {
                    if (index) {
                        if (flat) this.write(" ")
                        else this.newline(inner)
                    }
                    this.print(item, index && !flat ? inner : indent, index === last ? tail : 0)
                })
            case "object":
                if (flat) {
                    this.write("{ ")
                    group.items.forEach((item, index) => (index && this.write("; "), this.print(item, indent)))
                    return this.write(" }")
                }
                this.write("{")
                group.items.forEach((item) => {
                    this.newline(inner)
                    this.print(item, inner)
                })
                this.newline(indent)
                return this.write("}")
            case "list":
                this.write(group.open)
                if (flat || !group.items.length) {
                    group.items.forEach((item, index) => (index && this.write(", "), this.print(item, indent)))
                    return this.write(group.close)
                }
                // Short type arguments fill their lines instead of taking one line each
                if (group.open === "<" && group.items.every((item) => flatWidth(item) <= shortArgument)) {
                    this.newline(inner)
                    group.items.forEach((item, index) => {
                        const width = flatWidth(item) + (index < last ? 1 : 0)
                        if (index && this.column + 1 + width > this.width) this.newline(inner)
                        else if (index) this.write(" ")
                        this.print(item, inner)
                        if (index < last) this.write(",")
                    })
                } else {
                    group.items.forEach((item, index) => {
                        this.newline(inner)
                        this.print(item, inner, index < last ? 1 : 0)
                        if (index < last) this.write(",")
                    })
                }
                this.newline(indent)
                return this.write(group.close)
        }
    }
}

// The width of a broken group's last line, which the text after the group continues
function lastLine(group: Group, indent: number, level: number, step: number): number {
    const lastItem = group.items[group.items.length - 1] ?? []
    switch (group.mode) {
        case "list":
        case "object":
            return indent + group.close.length
        case "union":
        case "and":
            return level + 2 + flatWidth(lastItem)
        case "fn":
            return indent + step + 3 + flatWidth(lastItem)
        case "cond":
            return indent + step + 2 + flatWidth(lastItem)
        case "seq":
            return indent + step + flatWidth(lastItem)
    }
}

function render(pieces: Piece[], width: number, start = 0): string {
    const printer = new Printer(width)
    printer.column = start
    printer.lineStart = start === 0
    printer.print(pieces, 0)
    return printer.html
}

/** Column limits in characters. Every column at least 650 pixels wide holds 68. On a phone a signature panel holds 35,
 * and a type without a panel 38 */
export const signatureWidth = 68
export const typeWidth = 68
export const narrowWidth = 35
export const narrowTypeWidth = 38

/** A printed type at the wide and the narrow column width. When the two differ, both are kept and the styles show the
 * one that fits. Search indexes only the wide one */
export function fitted(print: (width: number) => string, narrow = narrowWidth): string {
    const wide = print(typeWidth)
    const small = print(narrow)
    return wide === small ? wide : `<span class="ty-wide">${wide}</span><span class="ty-narrow" data-pagefind-ignore>${small}</span>`
}

export const typeHtml = (type: Type, width = typeWidth) => render(typePieces(type), width)

export function signatureHtml(signature: Signature, name: string, options: { isConstructor?: boolean; isStatic?: boolean } = {}, width = signatureWidth): string {
    const prefix = [...(options.isStatic ? [text("static ", "k")] : []), ...(options.isConstructor ? [text("new ", "k")] : [])]
    return render(signaturePieces(signature, name, prefix), width)
}

export function declarationHtml(
    kind: "variable" | "type" | "interface" | "class",
    name: string,
    options: { type?: Type; tp?: TypeParameter[]; extends?: Type[]; implements?: Type[]; const?: boolean },
    width = signatureWidth,
): string {
    const keyword = kind === "variable" ? (options.const ? "const" : "let") : kind
    const pieces: Piece[] = [text(`${keyword} `, "k"), text(name, "n"), ...typeParameterPieces(options.tp)]
    if (kind === "variable") pieces.push(text(": "), ...typePieces(options.type ?? "unknown"))
    if (kind === "type") {
        // A long union or conditional starts on its own line below the name
        const type = typePieces(options.type ?? "unknown")
        // Lists and objects break inside their brackets instead
        const loose = !(type.length === 1 && isGroup(type[0]!) && (type[0].mode === "list" || type[0].mode === "object"))
        if (loose && flatWidth([...pieces, text(" = "), ...type]) > width && flatWidth(pieces) <= width) {
            const printer = new Printer(width)
            printer.print([...pieces, text(" =")], 0)
            printer.newline(4)
            printer.print(type, 4)
            return printer.html
        }
        pieces.push(text(" = "), ...type)
    }
    // Heritage clauses move to their own lines when the declaration line is too long
    const heritage = (word: string, types?: Type[]) =>
        types?.length ? [[text(`${word} `, "k"), ...types.flatMap((type, index) => [...(index ? [text(", ")] : []), ...typePieces(type)])]] : []
    const clauses = [...heritage("extends", options.extends), ...heritage("implements", options.implements)]
    return render(clauses.length ? [seq([pieces, ...clauses])] : pieces, width)
}

export const propertyHtml = (member: Member, width = signatureWidth) =>
    render([...(member.readonly ? [text("readonly ", "k")] : []), text(member.name, "n"), text(member.optional ? "?: " : ": "), ...typePieces(member.type ?? "unknown")], width)

/** The error types a Result, ResultAsync, Effect or Stream can fail with, when its error argument is not never */
export function failureTypes(type: Type): Type[] {
    if (typeof type !== "object" || !("r" in type) || !["Result", "ResultAsync", "Effect", "Stream"].includes(type.r)) return []
    const error = type.a?.[1]
    if (error === undefined || error === "never") return []
    return typeof error === "object" && "k" in error && error.k === "union" ? error.t : [error]
}

export const isObjectType = (type: Type | undefined): type is ObjectType => typeof type === "object" && "k" in type && type.k === "obj"

// The members an object type spells out: an object, an Omit of one, or an intersection of those, where a later part
// replaces a member of the same name. Undefined for any other type
function spelledMembers(type: Type | undefined): Member[] | undefined {
    if (isObjectType(type)) return type.s?.length || type.x?.length ? undefined : (type.m ?? [])
    if (typeof type !== "object") return undefined
    if ("r" in type && type.r === "Omit" && type.a?.length === 2) {
        const members = spelledMembers(type.a[0])
        const keys = type.a[1]!
        const omitted = (typeof keys === "object" && "k" in keys && keys.k === "union" ? keys.t : [keys]).map((key) => (typeof key === "string" ? key.replace(/^"|"$/g, "") : undefined))
        if (!members || omitted.includes(undefined)) return undefined
        return members.filter((member) => !omitted.includes(member.name))
    }
    if ("k" in type && type.k === "and") {
        const parts = type.t.map(spelledMembers)
        if (parts.some((part) => !part)) return undefined
        const merged = new Map<string, Member>()
        for (const member of parts.flat() as Member[]) merged.set(member.name, member)
        // By name, as the extractor lists every object's members, so a replaced member keeps its place
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "en"))
    }
    return undefined
}

/** The fields of an options object whose fields are documented, in their own order, so a page lists them instead of
 * printing one long type */
export function documentedFields(type: Type | undefined): Member[] | undefined {
    const members = spelledMembers(type)
    return members?.length && members.some((member) => member.doc) ? members : undefined
}
