import { fileURLToPath } from "node:url"
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast"
import { API, SymbolFlags, TypeFlags, type Checker, type InterfaceType, type Type } from "typescript/unstable/sync"

/** One place where SDK source turns a value into text, found by the type-aware output boundary scan */
export interface Conversion {
    /** Source path under src, such as internal/logging.ts */
    readonly file: string
    /** 1-based line of the converted expression */
    readonly line: number
    /** How the value becomes text, such as JSON.stringify, String, template, concatenation or a util import */
    readonly kind: string
    /** The converted expression or import as written, which identifies an allowed conversion */
    readonly expression: string
}

/** The masking.ts converters. A conversion inside their arguments is masked text, when the call resolves to masking.ts */
const maskingCalls = new Set([
    "maskText",
    "maskValue",
    "maskPayload",
    "maskedSummary",
    "maskedMessage",
    "maskedErrorCode",
])
/** Named node:util exports that never turn a value into text */
const safeUtilImports = new Set(["types", "isDeepStrictEqual"])
const unknownFlags = TypeFlags.Any | TypeFlags.Unknown

const source = fileURLToPath(new URL("../../src/", import.meta.url))
const configFile = fileURLToPath(new URL("../../tsconfig.json", import.meta.url))

/**
 * Scan SDK source with the type checker for every place outside masking.ts that turns an unknown value into text.
 * It finds:
 * - Any node:util import other than types and isDeepStrictEqual, whatever its spelling: Named, namespace, default,
 *   require or dynamic import, because inspect and format are the general converters
 * - A console call with an argument that is not a string, because console formats it with util.format, or that is the
 *   message or stack of an application Error
 * - A process.stdout.write or process.stderr.write of an unknown value or of an application Error's message or stack
 * - JSON.stringify of a value whose type holds unknown or any anywhere inside it
 * - String(), a template literal, + or += concatenation, a string's concat, join or toString of a value typed unknown,
 *   any, an unconstrained type parameter or an application Error, and the message or stack of an application Error in
 *   those positions
 * Arguments of a masking.ts converter are skipped only when the call resolves to masking.ts, not by its name.
 * It cannot find:
 * - Application text whose static type is a concrete type, such as a string or a { password: string } object that came
 *   from an application value, including an application Error's message once it is stored in a string variable,
 *   returned from a function or passed through a cast
 * - Text built by a function that returns string, and conversions inside dependencies
 * - Output through other sinks than console and process output, such as a file stream
 * Those stay covered by the masked choke points that the surface tests exercise, which in turn can only check output
 * paths that a test calls
 */
export function unmaskedConversions(): Conversion[] {
    const api = new API({ cwd: source })
    try {
        const snapshot = api.updateSnapshot({ openProjects: [configFile] })
        const project = snapshot.getProjects()[0]!
        const { checker, program } = project
        const files = program
            .getSourceFileNames()
            .filter((name) => name.startsWith(source) && !name.endsWith("/internal/masking.ts"))
        const errorTypes = typesNamed(checker, program.getSourceFile(`${source}errors.ts`)!, ["FluxerlyError"])
        const scan = new Scan(checker, errorTypes[0])
        return files.flatMap((name) => scan.file(program.getSourceFile(name)!, name.slice(source.length)))
    } finally {
        api.close()
    }
}

/** The instance types of classes declared in a file, by name */
function typesNamed(checker: Checker, file: SourceFile, names: readonly string[]): (Type | undefined)[] {
    const found = new Map<string, Type | undefined>()
    const visit = (node: Node) => {
        if (node.kind === SyntaxKind.ClassDeclaration) {
            const name = (node as unknown as { name?: Node & { text: string } }).name
            if (name && names.includes(name.text)) found.set(name.text, checker.getTypeAtLocation(name))
        }
        node.forEachChild(visit)
    }
    visit(file)
    return names.map((name) => found.get(name))
}

class Scan {
    readonly #checker: Checker
    readonly #sdkErrorType: Type | undefined

    constructor(checker: Checker, sdkErrorType: Type | undefined) {
        this.#checker = checker
        this.#sdkErrorType = sdkErrorType
    }

    /** Whether text made from this type can hold application text: unknown, any, unconstrained or an application Error */
    unknownText(type: Type | undefined, depth = 0): boolean {
        if (type === undefined || depth > 4) return false
        if (type.flags & unknownFlags) return true
        if (type.flags & TypeFlags.TypeParameter) {
            const constraint = this.#checker.getBaseConstraintOfType(type)
            return constraint === undefined || constraint === type || this.unknownText(constraint, depth + 1)
        }
        if (type.isUnionType() || type.isIntersectionType())
            return (type.getTypes() ?? []).some((member) => this.unknownText(member, depth + 1))
        return this.applicationError(type)
    }

    /** Whether an object of this type is an Error that is not an SDK error, whose message is application text. Error
     * is matched by name through the base types, because a record with a name and a message is structurally an Error
     */
    applicationError(type: Type): boolean {
        if (!(type.flags & TypeFlags.Object) || !this.#extendsError(type, 0)) return false
        return !this.#sdkErrorType || !this.#checker.isTypeAssignableTo(type, this.#sdkErrorType)
    }

    #extendsError(type: Type, depth: number): boolean {
        if (depth > 8) return false
        if (type.getSymbol()?.name === "Error") return true
        const target = type.isTypeReference() ? type.getTarget() : type
        if (!target.isClassOrInterface()) return false
        return this.#checker.getBaseTypes(target as InterfaceType).some((base) => this.#extendsError(base, depth + 1))
    }

    /** Whether a value of this type holds unknown or any anywhere that JSON.stringify would write */
    holdsUnknown(type: Type | undefined, depth = 0, seen = new Set<number>()): boolean {
        if (type === undefined || depth > 3 || seen.has(type.id)) return false
        seen.add(type.id)
        if (this.unknownText(type)) return true
        if (type.isUnionType() || type.isIntersectionType())
            return (type.getTypes() ?? []).some((member) => this.holdsUnknown(member, depth + 1, seen))
        if (!(type.flags & TypeFlags.Object)) return false
        if (this.#checker.getIndexInfosOfType(type).some((info) => this.holdsUnknown(info.valueType, depth + 1, seen)))
            return true
        return this.#checker
            .getPropertiesOfType(type)
            .some((property) => this.holdsUnknown(this.#checker.getTypeOfSymbol(property), depth + 1, seen))
    }

    /** Whether an expression is the message or stack of an application Error, also in parentheses or as an operand of
     * ?? or ||, as in error.stack ?? ""
     */
    errorText(node: Node): boolean {
        const kind: number = node.kind
        if (kind === SyntaxKind.ParenthesizedExpression)
            return this.errorText((node as unknown as { expression: Node }).expression)
        if (kind === SyntaxKind.BinaryExpression) {
            const binary = node as unknown as { left: Node; right: Node; operatorToken: Node }
            const operator: number = binary.operatorToken.kind
            return (
                (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) &&
                (this.errorText(binary.left) || this.errorText(binary.right))
            )
        }
        if (kind !== SyntaxKind.PropertyAccessExpression) return false
        const access = node as unknown as { expression: Node; name: Node & { text: string } }
        if (access.name.text !== "message" && access.name.text !== "stack") return false
        const receiver = this.#checker.getTypeAtLocation(access.expression)
        return (
            receiver !== undefined &&
            (this.unknownText(receiver) ||
                ((receiver.isUnionType() || receiver.isIntersectionType()) &&
                    (receiver.getTypes() ?? []).some((member) => this.applicationError(member))))
        )
    }

    /** Whether a callee resolves, through imports, to a function declared in masking.ts */
    maskingCall(callee: Node): boolean {
        const target =
            callee.kind === SyntaxKind.PropertyAccessExpression ? (callee as unknown as { name: Node }).name : callee
        let symbol = this.#checker.getSymbolAtLocation(target)
        if (symbol && symbol.flags & SymbolFlags.Alias) symbol = this.#checker.getAliasedSymbol(symbol)
        return symbol?.declarations.some((declaration) => declaration.path.endsWith("/internal/masking.ts")) ?? false
    }

    file(file: SourceFile, name: string): Conversion[] {
        const found: Conversion[] = []
        const text = file.text
        const add = (kind: string, node: Node) =>
            found.push({
                file: name,
                line:
                    text.slice(0, node.pos).split("\n").length +
                    (/^\s*\n/.test(text.slice(node.pos, node.end)) ? 1 : 0),
                kind,
                expression: text.slice(node.pos, node.end).trim().replace(/\s+/g, " "),
            })
        const calleeNode = (node: Node) => (node as unknown as { expression: Node }).expression
        const callee = (node: Node) => {
            const expression = calleeNode(node)
            return text.slice(expression.pos, expression.end).trim()
        }
        const textValue = (node: Node) =>
            this.unknownText(this.#checker.getTypeAtLocation(node)) || this.errorText(node)
        const utilModule = (node: Node | undefined) =>
            node !== undefined &&
            node.kind === SyntaxKind.StringLiteral &&
            ["node:util", "util"].includes((node as unknown as { text: string }).text)
        const visit = (node: Node) => {
            // Switched as a number: Only these few kinds convert values, so the rest need no case
            const kind: number = node.kind
            switch (kind) {
                case SyntaxKind.ImportDeclaration:
                case SyntaxKind.ExportDeclaration: {
                    const declaration = node as unknown as {
                        moduleSpecifier?: Node
                        importClause?: { name?: Node; namedBindings?: Node & { elements?: readonly Node[] } }
                    }
                    if (!utilModule(declaration.moduleSpecifier)) break
                    const clause = declaration.importClause
                    const elements = clause?.namedBindings?.elements
                    const safe =
                        clause !== undefined &&
                        clause.name === undefined &&
                        elements !== undefined &&
                        elements.every((element) => {
                            const specifier = element as unknown as {
                                propertyName?: { text: string }
                                name: { text: string }
                            }
                            return safeUtilImports.has((specifier.propertyName ?? specifier.name).text)
                        })
                    if (!safe) add("node:util import", node)
                    break
                }
                case SyntaxKind.CallExpression: {
                    const call = node as unknown as { arguments: readonly Node[] }
                    const name = callee(node)
                    // The arguments of a masking converter become masked text
                    if (maskingCalls.has(name.split(".").at(-1)!) && this.maskingCall(calleeNode(node))) return
                    const first = call.arguments[0]
                    if ((name === "require" || name === "import") && utilModule(first)) add("node:util import", node)
                    else if (
                        name === "JSON.stringify" &&
                        first &&
                        this.holdsUnknown(this.#checker.getTypeAtLocation(first))
                    )
                        add("JSON.stringify", first)
                    else if (name === "String" && first && textValue(first)) add("String", first)
                    else if (/^console\.\w+$/.test(name))
                        for (const argument of call.arguments) {
                            const type = this.#checker.getTypeAtLocation(argument)
                            if (
                                !type ||
                                !(type.flags & (TypeFlags.StringLike | TypeFlags.Never)) ||
                                this.errorText(argument)
                            )
                                add("console", argument)
                        }
                    else if (/^process\.(?:stdout|stderr)\.write$/.test(name) && first && textValue(first))
                        add("process output", first)
                    else if (name.endsWith(".concat")) {
                        const receiver = (node as unknown as { expression: { expression: Node } }).expression.expression
                        const type = this.#checker.getTypeAtLocation(receiver)
                        if (type && type.flags & TypeFlags.StringLike)
                            for (const argument of call.arguments) if (textValue(argument)) add("concat", argument)
                    } else if (/\.(?:join|toString)$/.test(name)) {
                        const receiver = (node as unknown as { expression: { expression: Node } }).expression.expression
                        const type = this.#checker.getTypeAtLocation(receiver)
                        if (name.endsWith(".toString") ? textValue(receiver) : this.holdsUnknown(type))
                            add(name.endsWith(".toString") ? "toString" : "join", receiver)
                    }
                    break
                }
                case SyntaxKind.TemplateSpan: {
                    const expression = (node as unknown as { expression: Node }).expression
                    if (textValue(expression)) add("template", expression)
                    break
                }
                case SyntaxKind.BinaryExpression: {
                    const binary = node as unknown as { left: Node; right: Node; operatorToken: Node }
                    const operator: number = binary.operatorToken.kind
                    if (operator !== SyntaxKind.PlusToken && operator !== SyntaxKind.PlusEqualsToken) break
                    const sides = [binary.left, binary.right]
                    const types = sides.map((side) => this.#checker.getTypeAtLocation(side))
                    if (!types.some((type) => type && type.flags & TypeFlags.StringLike)) break
                    sides.forEach((side) => {
                        if (textValue(side)) add("concatenation", side)
                    })
                    break
                }
            }
            node.forEachChild(visit)
        }
        visit(file)
        return found
    }
}
