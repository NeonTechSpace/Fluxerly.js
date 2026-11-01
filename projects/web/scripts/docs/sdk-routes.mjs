// Finds which Fluxer HTTP route each public Fluxerly operation sends, by reading the SDK source with the TypeScript
// compiler. Nothing runs: a small evaluator follows each operation from its public entry, through the functions it
// calls, to the place where a request leaves the SDK, and reads the method and path there. A request builder's path is
// a template such as `/guilds/${guildId}/${kind}`, so the evaluator binds the literal arguments a call passes, such as
// "emojis", and turns every value it cannot know, such as a guild ID, into a path parameter. What it cannot read with
// certainty, such as a path segment of unknown shape or a method that depends on an unknown condition, is reported as
// unresolved instead of guessed
import ts from "typescript"
import { readdirSync } from "node:fs"
import { join } from "node:path"

// Abstract values. A value is a list of alternatives, each one of these
const TOP = Object.freeze({ k: "top" })
// Known to be neither undefined nor null, such as a required string parameter
const TOP_DEFINED = Object.freeze({ k: "top", defined: true })
// An unknown single path segment, such as a channel ID or an encoded emoji
const top = (defined, segment) => (segment ? { k: "top", defined, segment: true } : defined ? TOP_DEFINED : TOP)
const NONE = Object.freeze({ k: "none" })
// An instance of a class, such as a validation failure or URLSearchParams. Never a request, and unknown as text
const INSTANCE = Object.freeze({ k: "inst" })
const UNDEF = Object.freeze({ k: "undef" })
const NULL = Object.freeze({ k: "null" })
const str = (v) => ({ k: "str", v })
const bool = (v) => ({ k: "bool", v })

// Unknown parts of a path. One that fills a single segment, such as an ID, becomes a path parameter. One that may
// hold slashes or a query, such as a whole path from elsewhere, makes the path unresolved
export const HOLE_SEGMENT = "\u0001"
export const HOLE_ANY = "\u0002"

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
// More alternatives than this means the evaluator is enumerating something it does not understand
const alternativesLimit = 32
const depthLimit = 48
// Names of values that may hold more than one path segment or a query, so an unknown one never becomes a parameter
const multiSegmentName = /path|suffix|url|route|query|search|params|prefix|base|href|origin/i

const unwrap = (node) => {
    while (
        node &&
        (ts.isParenthesizedExpression(node) ||
            ts.isAsExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isSatisfiesExpression(node) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isExpressionWithTypeArguments(node))
    )
        node = node.expression
    return node
}

const isFunctionLike = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node)

const dedupe = (values) => {
    const seen = new Set()
    const out = []
    for (const value of values) {
        const key = value.k === "str" ? `s:${value.v}` : value.k === "bool" ? `b:${value.v}` : value.k === "obj" || value.k === "fn" || value.k === "arr" || value.k === "eff" ? null : value.k === "inst" ? `i:${value.symbol?.name ?? ""}` : `${value.k}:${value.defined ?? ""}:${value.segment ?? ""}`
        if (key === null) {
            if (!out.includes(value)) out.push(value)
            continue
        }
        if (seen.has(key)) continue
        seen.add(key)
        out.push(value)
    }
    return out.length > alternativesLimit ? [TOP] : out
}

let envIds = 0
class Env {
    constructor(parent) {
        this.id = ++envIds
        this.parent = parent
        this.bindings = new Map()
        this.constants = new Map()
    }
    lookup(symbol) {
        for (let env = this; env; env = env.parent) if (env.bindings.has(symbol)) return env.bindings.get(symbol)
        return undefined
    }
}

/**
 * Reads routes out of a TypeScript program
 * @param {ts.Program} program
 * @param {{ sinks: Sink[], isSource?: (file: string) => boolean }} options
 *
 * A sink is a function where a request leaves the SDK. `request` names the argument holding an object with method,
 * path and webhookId. `path` and `init` name a path argument and a fetch init whose method defaults to GET. `url` names
 * an absolute URL argument whose unknown origin is dropped
 * @typedef {{ file: RegExp, name: string, request?: number, path?: number, init?: number, url?: number, method?: string }} Sink
 */
export class RouteAnalyzer {
    constructor(program, { sinks, isSource }) {
        this.program = program
        this.checker = program.getTypeChecker()
        this.sinks = sinks
        this.isSource = isSource ?? ((file) => !file.endsWith(".d.ts") && !/[\\/]node_modules[\\/]/.test(file))
        this.memo = new Map()
        this.active = new Set()
        this.stack = []
        this.depth = 0
    }

    /** The routes one entry function reaches, as "METHOD /path" keys, and what could not be read */
    routesOf(fn) {
        const collector = { routes: new Set(), unresolved: new Set() }
        this.stack.push(collector)
        try {
            this.walkFunction(fn, new Env(undefined))
        } finally {
            this.stack.pop()
        }
        return { routes: [...collector.routes].sort(), unresolved: [...collector.unresolved].sort() }
    }

    get collector() {
        return this.stack.at(-1)
    }

    where(node) {
        const file = node.getSourceFile()
        const { line } = file.getLineAndCharacterOfPosition(node.getStart())
        return `${file.fileName.split(/[\\/]/).slice(-2).join("/")}:${line + 1}`
    }

    // Walking runs every call a function body makes, including calls inside callbacks it hands to other code, such as
    // Effect.suspend(() => ...), since the SDK runs those callbacks too

    walkFunction(fn, env) {
        const local = new Env(env)
        if (fn.body) this.walk(fn.body, local)
    }

    walk(node, env) {
        if (!node || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
        if (isFunctionLike(node)) return this.walkFunction(node, env)
        if (ts.isCallExpression(node)) {
            this.walk(node.expression, env)
            for (const argument of node.arguments) this.walk(argument, env)
            this.call(node, env)
            return
        }
        // A branch whose condition is known not to hold sends nothing, such as a DM type check for a user read
        if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
            const condition = ts.isIfStatement(node) ? node.expression : node.condition
            const [whenTrue, whenFalse] = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse]
            this.walk(condition, env)
            const value = truth(this.eval(condition, env))
            if (value !== false) this.walk(whenTrue, env)
            if (value !== true && whenFalse) this.walk(whenFalse, env)
            return
        }
        ts.forEachChild(node, (child) => this.walk(child, env))
    }

    // Calls

    targetsOf(callee, env) {
        const expression = unwrap(callee)
        // A parameter bound to a function, such as the build callback an executor receives
        if (ts.isIdentifier(expression)) {
            const symbol = this.symbolOf(expression)
            const bound = symbol && env.lookup(symbol)
            if (bound) return bound.filter((value) => value.k === "fn").map((value) => ({ node: value.node, env: value.env }))
        }
        // A function held by a known object, such as the request callback of a built read
        if (ts.isPropertyAccessExpression(expression) && expression.expression.kind !== ts.SyntaxKind.ThisKeyword) {
            const held = this.eval(expression, env).filter((value) => value.k === "fn")
            if (held.length) return held.map((value) => ({ node: value.node, env: value.env }))
        }
        const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression
        const symbol = this.symbolOf(name)
        if (!symbol) return []
        const targets = []
        for (const declaration of symbol.declarations ?? []) {
            const fn = isFunctionLike(declaration)
                ? declaration
                : (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
                    declaration.initializer &&
                    isFunctionLike(unwrap(declaration.initializer))
                  ? unwrap(declaration.initializer)
                  : undefined
            if (fn && fn.body && this.isSource(fn.getSourceFile().fileName)) targets.push({ node: fn, env: undefined })
        }
        return targets
    }

    sinkOf(target) {
        const name = functionName(target.node)
        if (!name) return undefined
        const file = target.node.getSourceFile().fileName.replaceAll("\\", "/")
        return this.sinks.find((sink) => sink.name === name && sink.file.test(file))
    }

    call(node, env) {
        const callee = unwrap(node.expression)
        const text = ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText()}.${callee.name.text}` : callee.getText()
        if (text === "Object.freeze" && node.arguments[0]) return this.eval(node.arguments[0], env)
        if (text === "encodeURIComponent") return [top(true, true)]
        // Enough of Effect to follow a value handed from one step to the next, as in
        // suspendInput(() => Effect.succeed([request, timeout])).pipe(Effect.flatMap(([request]) => send(request)))
        if (text === "Effect.succeed") return [{ k: "eff", values: node.arguments[0] ? this.eval(node.arguments[0], env) : [UNDEF] }]
        if (text === "Effect.suspend" && node.arguments[0])
            return dedupe(this.eval(node.arguments[0], env).flatMap((value) => (value.k === "fn" ? this.invoke({ node: value.node, env: value.env }, []) : [TOP])))
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pipe") {
            const effects = this.eval(callee.expression, env).filter((value) => value.k === "eff")
            if (effects.length) return [{ k: "eff", values: this.pipe(effects.flatMap((effect) => effect.values), node.arguments, env) }]
        }
        const targets = this.targetsOf(callee, env)
        if (!targets.length) return [TOP]
        const sink = targets.map((target) => this.sinkOf(target)).find(Boolean)
        if (sink) {
            this.record(sink, node, env)
            return [TOP]
        }
        const args = node.arguments.map((argument) => (ts.isSpreadElement(argument) ? [TOP] : this.eval(argument, env)))
        return dedupe(targets.flatMap((target) => this.invoke(target, args)))
    }

    // The success values after each step of a pipe. A step that only handles failures keeps them
    pipe(values, steps, env) {
        let current = dedupe(values)
        for (const step of steps) {
            const call = unwrap(step)
            if (!ts.isCallExpression(call) || !call.arguments[0]) continue
            const name = call.expression.getText()
            if (!["Effect.flatMap", "Effect.andThen", "Effect.map", "Effect.tap"].includes(name)) continue
            const functions = this.eval(call.arguments[0], env).filter((value) => value.k === "fn")
            if (!functions.length) {
                current = name === "Effect.tap" ? current : [TOP]
                continue
            }
            const returns = dedupe(functions.flatMap((value) => this.invoke({ node: value.node, env: value.env }, [current])))
            if (name === "Effect.map") current = returns
            else if (name !== "Effect.tap") current = dedupe(returns.flatMap((value) => (value.k === "eff" ? value.values : [TOP])))
        }
        return current
    }

    // Binds a parameter, reading destructured elements from known arrays and objects
    bind(env, name, values) {
        if (ts.isIdentifier(name)) {
            const symbol = this.symbolOf(name)
            if (symbol) env.bindings.set(symbol, values)
            return
        }
        name.elements.forEach((element, index) => {
            if (ts.isOmittedExpression(element) || element.dotDotDotToken) return
            const key = ts.isObjectBindingPattern(name) ? (element.propertyName ?? element.name).getText() : undefined
            const inner = values.flatMap((value) =>
                key === undefined
                    ? value.k === "arr" ? (value.items[index] ?? [UNDEF]) : [TOP]
                    : value.k === "obj" ? (this.prop(value, key) ?? [UNDEF]) : [TOP],
            )
            this.bind(env, element.name, dedupe(inner))
        })
    }

    invoke(target, args) {
        const key = `${target.node.pos}:${target.node.getSourceFile().fileName}:${target.env?.id ?? 0}:${args.map(keyOf).join("|")}`
        const remembered = this.memo.get(key)
        if (remembered) {
            for (const route of remembered.routes) this.collector.routes.add(route)
            for (const item of remembered.unresolved) this.collector.unresolved.add(item)
            return remembered.returns
        }
        if (this.active.has(key) || this.depth > depthLimit) return [TOP]
        this.active.add(key)
        this.depth++
        const collector = { routes: new Set(), unresolved: new Set() }
        this.stack.push(collector)
        let returns
        try {
            const env = new Env(target.env)
            target.node.parameters.forEach((parameter, index) => {
                if (parameter.dotDotDotToken) return
                const value = args[index] ?? (parameter.initializer ? this.eval(parameter.initializer, env) : [UNDEF])
                this.bind(env, parameter.name, value)
            })
            if (target.node.body) this.walk(target.node.body, env)
            returns = this.returnsOf(target.node, env)
        } finally {
            this.stack.pop()
            this.depth--
            this.active.delete(key)
        }
        for (const route of collector.routes) this.collector.routes.add(route)
        for (const item of collector.unresolved) this.collector.unresolved.add(item)
        this.memo.set(key, { returns, routes: collector.routes, unresolved: collector.unresolved })
        return returns
    }

    returnsOf(fn, env) {
        if (!fn.body) return [TOP]
        if (!ts.isBlock(fn.body)) return this.eval(fn.body, env)
        const values = []
        const visit = (node) => {
            if (isFunctionLike(node)) return
            if (ts.isReturnStatement(node)) values.push(...(node.expression ? this.eval(node.expression, env) : [UNDEF]))
            else ts.forEachChild(node, visit)
        }
        visit(fn.body)
        return dedupe(values.length ? values : [UNDEF])
    }

    // Requests

    record(sink, node, env) {
        const argument = (index) => (node.arguments[index] ? this.eval(node.arguments[index], env) : [UNDEF])
        const found = []
        if (sink.request !== undefined) {
            for (const request of argument(sink.request)) {
                if (request.k === "none" || request.k === "undef" || request.k === "inst") continue
                if (request.k !== "obj") {
                    found.push({ unresolved: "request object" })
                    continue
                }
                const methodValues = this.prop(request, "method") ?? [UNDEF]
                const pathValues = this.prop(request, "path") ?? [UNDEF]
                const webhook = present(this.prop(request, "webhookId") ?? [UNDEF])
                if (webhook === undefined) found.push({ unresolved: "webhook token prefix" })
                // Token-authenticated webhook requests carry a path relative to /webhooks/{webhook_id}/{token}
                found.push(...pairs(methodValues, pathValues, webhook ? "/webhooks/{}/{}" : ""))
            }
        } else if (sink.path !== undefined) {
            const init = argument(sink.init)
            const methodValues = init.flatMap((value) => (value.k === "obj" ? (this.prop(value, "method") ?? [str("GET")]) : [TOP]))
            found.push(...pairs(methodValues, argument(sink.path), ""))
        } else if (sink.url !== undefined) {
            // An absolute URL whose origin is the configured instance, so the unknown origin is dropped
            const paths = argument(sink.url).map((value) => (value.k === "str" ? str(value.v.replace(/^[\u0001\u0002]+/, "")) : value))
            found.push(...pairs([str(sink.method ?? "GET")], paths, ""))
        }
        for (const item of found) {
            if (item.unresolved) this.collector.unresolved.add(`${item.unresolved} at ${this.where(node)}`)
            else this.collector.routes.add(item.route)
        }
    }

    // Evaluation

    symbolOf(node) {
        let symbol =
            node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
                ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
                : this.checker.getSymbolAtLocation(node)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol)
        return symbol
    }

    eval(node, env) {
        node = unwrap(node)
        if (!node) return [UNDEF]
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [str(node.text)]
        if (ts.isNumericLiteral(node)) return [str(node.text)]
        if (node.kind === ts.SyntaxKind.TrueKeyword) return [bool(true)]
        if (node.kind === ts.SyntaxKind.FalseKeyword) return [bool(false)]
        if (node.kind === ts.SyntaxKind.NullKeyword) return [NULL]
        if (ts.isTemplateExpression(node)) return this.template(node, env)
        if (ts.isIdentifier(node)) return this.identifier(node, env)
        if (ts.isPropertyAccessExpression(node)) return this.member(node, env)
        if (ts.isConditionalExpression(node)) {
            const condition = truth(this.eval(node.condition, env))
            if (condition === true) return this.eval(node.whenTrue, env)
            if (condition === false) return this.eval(node.whenFalse, env)
            return dedupe([...this.eval(node.whenTrue, env), ...this.eval(node.whenFalse, env)])
        }
        if (ts.isBinaryExpression(node)) return this.binary(node, env)
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
            const value = truth(this.eval(node.operand, env))
            return value === undefined ? [TOP_DEFINED] : [bool(!value)]
        }
        if (ts.isCallExpression(node)) return this.call(node, env)
        if (ts.isElementAccessExpression(node)) {
            // A lookup table indexed by a known key, such as archivedPaths[scope]
            const keys = this.eval(node.argumentExpression, env)
            const out = []
            for (const value of this.eval(node.expression, env))
                for (const key of keys)
                    out.push(...(value.k === "obj" && key.k === "str" ? (this.prop(value, key.v) ?? [UNDEF]) : [TOP]))
            return dedupe(out)
        }
        if (ts.isObjectLiteralExpression(node)) return [{ k: "obj", node, env }]
        if (ts.isArrayLiteralExpression(node)) return [{ k: "arr", items: node.elements.map((element) => (ts.isSpreadElement(element) ? [TOP] : this.eval(element, env))) }]
        if (isFunctionLike(node)) return [{ k: "fn", node, env }]
        if (ts.isNewExpression(node)) return [{ k: "inst", symbol: this.checker.getTypeAtLocation(node).getSymbol() }]
        if (ts.isAwaitExpression(node)) return this.eval(node.expression, env)
        return [TOP]
    }

    template(node, env) {
        let results = [node.head.text]
        for (const span of node.templateSpans) {
            const values = this.eval(span.expression, env)
            const parts = []
            for (const value of values) {
                if (value.k === "none") continue
                parts.push(value.k === "str" ? value.v : value.k === "undef" ? "undefined" : value.k === "null" ? "null" : value.k === "bool" ? String(value.v) : value.k === "top" && value.segment ? HOLE_SEGMENT : HOLE_ANY)
            }
            if (!parts.length) return [NONE]
            const next = []
            for (const result of results) for (const part of new Set(parts)) next.push(result + part + span.literal.text)
            results = next
            if (results.length > alternativesLimit) return [TOP]
        }
        return results.map(str)
    }

    identifier(node, env) {
        if (node.text === "undefined") return [UNDEF]
        const symbol = this.symbolOf(node)
        if (!symbol) return [this.unknownOf(node)]
        const bound = env.lookup(symbol)
        if (bound) return this.narrow(node, bound)
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
        if (!declaration) return [TOP]
        if (ts.isParameter(declaration)) return this.narrow(node, [this.unknownOf(node)])
        if (ts.isFunctionDeclaration(declaration)) return [{ k: "fn", node: declaration, env: undefined }]
        if (ts.isVariableDeclaration(declaration)) {
            const constant = ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
            if (!constant || !declaration.initializer || !ts.isIdentifier(declaration.name)) return [this.unknownOf(node)]
            return this.narrow(node, this.constant(declaration, declaration.initializer, env))
        }
        if (ts.isBindingElement(declaration)) {
            // const { request } = options reads a property of a known object
            const pattern = declaration.parent
            const holder = pattern?.parent
            if (ts.isObjectBindingPattern(pattern) && holder && ts.isVariableDeclaration(holder) && holder.initializer && ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const) {
                const name = (declaration.propertyName ?? declaration.name).getText()
                const source = this.constant(holder, holder.initializer, env)
                return this.narrow(node, dedupe(source.flatMap((value) => (value.k === "obj" ? (this.prop(value, name) ?? [UNDEF]) : value.k === "none" ? [NONE] : [this.unknownOf(node)]))))
            }
        }
        return [this.unknownOf(node)]
    }

    constant(declaration, initializer, env) {
        // A constant is evaluated once per environment that can see it
        for (let scope = env; scope; scope = scope.parent) if (scope.constants.has(declaration)) return scope.constants.get(declaration)
        const value = this.eval(initializer, env)
        env.constants.set(declaration, value)
        return value
    }

    // An unknown value that the type checker says can be neither undefined nor null is still known to be defined. A
    // named value, such as channelId or ref.id, fills one path segment unless its name says it may hold more
    unknownOf(node) {
        const type = this.checker.getTypeAtLocation(node)
        const parts = type.isUnion() ? type.types : [type]
        const maybeAbsent = parts.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
        const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined
        return top(!maybeAbsent, name !== undefined && !multiSegmentName.test(name))
    }

    // The checker's narrowing at a reference removes alternatives an earlier guard ruled out, such as a validation
    // failure after `if (input instanceof InputValidationFailure) return`, or undefined after `if (x === undefined) return`
    narrow(node, values) {
        const type = this.checker.getTypeAtLocation(node)
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return values
        const parts = type.isUnion() ? type.types : [type]
        // An unknown value whose type allows only a few strings, such as scope after its check, is one of them
        const literals = parts.every((part) => part.isStringLiteral() || part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
        if (literals && values.some((value) => value.k === "top"))
            values = dedupe(values.flatMap((value) => (value.k === "top" ? parts.map((part) => (part.isStringLiteral() ? str(part.value) : part.flags & ts.TypeFlags.Null ? NULL : UNDEF)) : [value])))
        if (parts.some((part) => part.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return values
        const canBeUndefined = parts.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))
        const canBeNull = parts.some((part) => part.flags & ts.TypeFlags.Null)
        // Only an object of a class, such as a validation failure, or a primitive rules an object literal out
        const primitive = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void
        const canBeObject = parts.some((part) => !(part.flags & primitive) && !(part.getSymbol()?.flags & ts.SymbolFlags.Class))
        // A reference narrowed to class instances alone, such as a returned validation failure, is never a request
        const classOnly = parts.every((part) => part.getSymbol()?.flags & ts.SymbolFlags.Class || part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
        // An instance stays when the reference can still be of its class
        const canBeInstance = (value) => parts.some((part) => (value.symbol ? part.getSymbol() === value.symbol : part.getSymbol()?.flags & ts.SymbolFlags.Class))
        const kept = values
            .filter((value) => (value.k === "undef" ? canBeUndefined : value.k === "null" ? canBeNull : value.k === "obj" ? canBeObject : value.k === "inst" ? canBeInstance(value) : true))
            .map((value) => (classOnly && value.k !== "undef" && value.k !== "null" && value.k !== "none" ? INSTANCE : value))
        return kept.length ? kept : [NONE]
    }

    member(node, env) {
        const name = node.name.text
        const out = []
        for (const value of this.eval(node.expression, env)) {
            if (value.k === "obj") out.push(...(this.prop(value, name) ?? [UNDEF]))
            else if (value.k === "none") out.push(NONE)
            else if (value.k === "undef" || value.k === "null") out.push(node.questionDotToken ? UNDEF : NONE)
            else out.push(this.unknownOf(node))
        }
        return this.narrow(node, dedupe(out))
    }

    /** A property of an object literal, reading spreads. Undefined when no alternative defines it */
    prop(value, name) {
        const properties = value.node.properties
        const found = []
        for (let index = properties.length - 1; index >= 0; index--) {
            const property = properties[index]
            if (ts.isSpreadAssignment(property)) {
                let missing = false
                for (const spread of this.eval(property.expression, value.env)) {
                    if (spread.k === "obj") {
                        const inner = this.prop(spread, name)
                        if (inner) found.push(...inner)
                        else missing = true
                    } else if (spread.k === "top") found.push(TOP)
                    else missing = true
                }
                if (!missing) return dedupe(found)
                continue
            }
            const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined
            if (key !== name) continue
            if (ts.isPropertyAssignment(property)) return dedupe([...found, ...this.eval(property.initializer, value.env)])
            if (ts.isShorthandPropertyAssignment(property)) return dedupe([...found, ...this.identifier(property.name, value.env)])
            return dedupe([...found, TOP])
        }
        return found.length ? dedupe([...found, UNDEF]) : undefined
    }

    binary(node, env) {
        const operator = node.operatorToken.kind
        const K = ts.SyntaxKind
        if ([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(operator)) {
            const negate = operator === K.ExclamationEqualsEqualsToken || operator === K.ExclamationEqualsToken
            const loose = operator === K.EqualsEqualsToken || operator === K.ExclamationEqualsToken
            const results = new Set()
            for (const left of this.eval(node.left, env))
                for (const right of this.eval(node.right, env)) {
                    const equal = same(left, right, loose)
                    results.add(equal === undefined ? undefined : negate ? !equal : equal)
                }
            return results.size === 1 && !results.has(undefined) ? [bool([...results][0])] : [TOP_DEFINED]
        }
        if (operator === K.AmpersandAmpersandToken || operator === K.BarBarToken) {
            const left = this.eval(node.left, env)
            const value = truth(left)
            if (operator === K.AmpersandAmpersandToken) return value === false ? left : value === true ? this.eval(node.right, env) : dedupe([...left, ...this.eval(node.right, env)])
            return value === true ? left : value === false ? this.eval(node.right, env) : dedupe([...left, ...this.eval(node.right, env)])
        }
        if (operator === K.QuestionQuestionToken) {
            const left = this.eval(node.left, env)
            const present = left.filter((value) => value.k !== "undef" && value.k !== "null")
            const absent = left.some((value) => value.k === "undef" || value.k === "null" || (value.k === "top" && !value.defined))
            return dedupe([...present, ...(absent ? this.eval(node.right, env) : [])])
        }
        if (operator === K.PlusToken) {
            const out = []
            for (const left of this.eval(node.left, env))
                for (const right of this.eval(node.right, env))
                    out.push(left.k === "str" && right.k === "str" ? str(left.v + right.v) : TOP)
            return dedupe(out)
        }
        return [TOP]
    }
}

const show = (values) => values.map((value) => (value.k === "str" ? JSON.stringify(value.v.replace(/\u0001/g, "{}").replace(/\u0002/g, "{…}")) : value.k)).join(" | ")

// A function's own name, or the name of the variable or property it is assigned to
function functionName(fn) {
    const named = fn.name ?? (fn.parent && (ts.isVariableDeclaration(fn.parent) || ts.isPropertyDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)) ? fn.parent.name : undefined)
    return named && (ts.isIdentifier(named) || ts.isPrivateIdentifier(named)) ? named.text : undefined
}

const keyOf = (values) =>
    values
        .map((value) => (value.k === "str" ? JSON.stringify(value.v) : value.k === "obj" || value.k === "fn" ? `${value.k}${value.node.pos}@${value.env?.id ?? 0}` : value.k === "arr" ? `[${value.items.map(keyOf).join(";")}]` : value.k === "eff" ? `eff(${keyOf(value.values)})` : `${value.k}${value.defined ? "!" : ""}${value.v ?? ""}`))
        .join(",")

function same(left, right, loose) {
    const absent = (value) => value.k === "undef" || value.k === "null"
    if (left.k === "top" || right.k === "top") {
        const other = left.k === "top" ? right : left
        const top = left.k === "top" ? left : right
        if (top.defined && absent(other)) return false
        return undefined
    }
    if (loose && absent(left) && absent(right)) return true
    if (left.k !== right.k) return left.k === "obj" || right.k === "obj" || left.k === "fn" || right.k === "fn" || left.k === "none" || right.k === "none" ? undefined : false
    if (left.k === "str" || left.k === "bool") return left.v === right.v
    if (absent(left)) return true
    return undefined
}

// Whether a property is set in every alternative, in none, or undefined when that is not known
function present(values) {
    const set = values.map((value) => (value.k === "undef" || value.k === "null" ? false : value.k === "str" || value.k === "obj" || (value.k === "top" && value.defined) ? true : undefined))
    return set.every((value) => value === true) ? true : set.every((value) => value === false) ? false : undefined
}

/** Whether every alternative is truthy, every one falsy, or undefined when that is not known */
export function truth(values) {
    let truthy = false
    let falsy = false
    for (const value of values) {
        if (value.k === "str") value.v ? (truthy = true) : (falsy = true)
        else if (value.k === "bool") value.v ? (truthy = true) : (falsy = true)
        else if (value.k === "undef" || value.k === "null") falsy = true
        else if (value.k === "obj" || value.k === "fn" || value.k === "inst") truthy = true
        else if (value.k === "none") continue
        else return undefined
    }
    return truthy && falsy ? undefined : truthy ? true : falsy ? false : undefined
}

/**
 * A request path as a route template: the query is dropped, and a segment with an unknown part becomes {}. Undefined
 * when the path has an unknown part that may span segments, or is not an absolute path
 */
export function routeTemplate(path) {
    const pathname = path.split("?")[0]
    if (pathname.includes(HOLE_ANY) || !pathname.startsWith("/")) return undefined
    const segments = pathname.slice(1).split("/")
    if (segments.some((segment) => segment === "" || segment.includes("undefined"))) return undefined
    return `/${segments.map((segment) => (segment.includes(HOLE_SEGMENT) ? "{}" : segment)).join("/")}`
}

// Each method alternative with each path alternative. When both vary, which method goes with which path is not known,
// so the pairs are unresolved rather than guessed
function pairs(methodValues, pathValues, prefix) {
    const found = []
    const methodsKnown = methodValues.filter((value) => value.k !== "none" && value.k !== "inst")
    const pathsKnown = pathValues.filter((value) => value.k !== "none" && value.k !== "inst")
    // Every alternative ruled out, such as a request built from a validation failure, is a request that never leaves
    if (!methodsKnown.length && !pathsKnown.length) return []
    if (!methodsKnown.length || !pathsKnown.length) return [{ unresolved: "no readable method or path" }]
    if (methodsKnown.length > 1 && pathsKnown.length > 1) return [{ unresolved: `method and path both vary: ${show(methodsKnown)} and ${show(pathsKnown)}` }]
    for (const method of methodsKnown)
        for (const path of pathsKnown) {
            if (method.k !== "str" || !methods.has(method.v)) {
                found.push({ unresolved: "method" })
                continue
            }
            if (path.k !== "str") {
                found.push({ unresolved: "path" })
                continue
            }
            const template = routeTemplate(`${prefix}${path.v}`)
            if (!template) found.push({ unresolved: `path ${JSON.stringify(`${prefix}${path.v}`.replace(/\u0001/g, "{}").replace(/\u0002/g, "{…}"))}` })
            else found.push({ route: `${method.v} ${template}` })
        }
    return found
}

// The SDK's entry points and request sinks

/** Where requests leave the Fluxerly SDK, relative to projects/sdk/src */
export const sdkSinks = [
    // Every REST request: the bot API, webhooks with a bot or webhook token, and caller-described requests
    { file: /\/internal\/rest\/owner\.ts$/, name: "#execute", request: 1 },
    // OAuth2 token and user requests, with the path and a fetch init
    { file: /\/internal\/oauth\.ts$/, name: "#request", path: 2, init: 3 },
    // The instance discovery document, read from the configured origin
    { file: /\/internal\/instance\.ts$/, name: "readDocument", url: 0, method: "GET" },
]

/** A TypeScript program over the SDK source, resolving its #sdk imports to source files */
export function sdkProgram(sdk) {
    const files = []
    const collect = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) collect(path)
            else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path)
        }
    }
    collect(join(sdk, "src"))
    return ts.createProgram({
        rootNames: files,
        options: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            customConditions: ["fluxerly-source"],
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            lib: ["lib.es2024.d.ts", "lib.esnext.disposable.d.ts", "lib.dom.d.ts"],
            types: [],
            skipLibCheck: true,
            noEmit: true,
        },
    })
}

const findFunction = (file, name) => {
    let found
    const visit = (node) => {
        if (found) return
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText() === name && node.body) found = node
        else ts.forEachChild(node, visit)
    }
    visit(file)
    return found
}

/** The object literal a function returns directly, looking through Object.freeze */
export function returnedObject(fn) {
    let found
    const visit = (node) => {
        if (found || (node !== fn && isFunctionLike(node))) return
        if (ts.isReturnStatement(node) && node.expression) {
            let expression = unwrap(node.expression)
            // Through a wrapper such as Object.freeze({ ... }) or the operation table's checked({ ... })
            while (ts.isCallExpression(expression) && expression.arguments.length === 1) expression = unwrap(expression.arguments[0])
            if (ts.isObjectLiteralExpression(expression)) found = expression
        }
        ts.forEachChild(node, visit)
    }
    visit(fn.body)
    return found
}

/** Members of a returned client object, with nested objects such as instance: { resolve } named by their path */
export function objectMembers(object, prefix) {
    const members = []
    for (const property of object.properties) {
        const name = property.name?.getText()
        if (!name) continue
        let value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : ts.isMethodDeclaration(property) ? property : undefined
        if (value && ts.isCallExpression(value) && value.expression.getText() === "Object.freeze") value = unwrap(value.arguments[0])
        if (value && ts.isObjectLiteralExpression(value)) members.push(...objectMembers(value, `${prefix}.${name}`))
        else if (value && isFunctionLike(value)) members.push({ name: `${prefix}.${name}`, fn: value })
    }
    return members
}

/**
 * Entries of the client operation table, which defines every client namespace member once for both the default and
 * the Effect API. Local reads, such as cache lookups, have no entry. Members with their own adapters per API list both
 */
export function tableEntries(checker, fn, prefix) {
    const table = returnedObject(fn)
    if (!table) throw new Error("The operation table is no longer a returned object literal")
    const entries = []
    for (const namespace of table.properties) {
        if (!ts.isPropertyAssignment(namespace) || !ts.isObjectLiteralExpression(unwrap(namespace.initializer))) continue
        for (const member of unwrap(namespace.initializer).properties) {
            if (!ts.isPropertyAssignment(member)) continue
            const name = `${prefix}.${namespace.name.getText()}.${member.name.getText()}`
            let call = unwrap(member.initializer)
            // named("id", entry) keeps an operation ID that differs from the key
            if (ts.isCallExpression(call) && call.expression.getText() === "named") call = unwrap(call.arguments[1])
            if (!ts.isCallExpression(call)) continue
            const kind = call.expression.getText()
            const functions = []
            if (kind === "op" || kind === "page" || kind === "lookup") functions.push(unwrap(call.arguments.at(-1)))
            else if (kind === "custom")
                for (const adapter of call.arguments.slice(1)) {
                    let symbol = checker.getSymbolAtLocation(unwrap(adapter))
                    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
                    // An adapter is a function, or a constant holding one
                    for (const candidate of symbol?.declarations ?? []) {
                        const fn = isFunctionLike(candidate) ? candidate : ts.isVariableDeclaration(candidate) && candidate.initializer ? unwrap(candidate.initializer) : undefined
                        if (fn && isFunctionLike(fn) && fn.body) functions.push(fn)
                    }
                }
            entries.push({ name, kind, functions: functions.filter((candidate) => candidate && isFunctionLike(candidate)) })
        }
    }
    return entries
}

/**
 * Every public Fluxerly operation that can send a request, with the routes it sends. Names follow the reference:
 * client.<namespace>.<member>, WebhookClient.<member> and OAuthClient.<member>
 */
export function sdkOperations(sdk) {
    const program = sdkProgram(sdk)
    const checker = program.getTypeChecker()
    const source = (path) => {
        const file = program.getSourceFile(join(sdk, "src", path).replaceAll("\\", "/")) ?? program.getSourceFile(join(sdk, "src", path))
        if (!file) throw new Error(`The SDK source no longer has ${path}`)
        return file
    }
    const required = (value, what) => {
        if (!value) throw new Error(`The SDK source no longer has ${what}`)
        return value
    }
    const entries = tableEntries(checker, required(findFunction(source("internal/binding/operations.ts"), "defineOperations"), "defineOperations"), "client")
    // The default API's token webhook and OAuth2 clients return their members as one frozen object. The Effect API's
    // clients have the same members, run the same owners and are checked by the SDK's public client contract
    const webhook = required(returnedObject(required(findFunction(source("api/default/webhook-client.ts"), "createWebhookClient"), "createWebhookClient")), "the webhook client object")
    const oauth = required(returnedObject(required(findFunction(source("api/default/oauth.ts"), "create"), "oauth.create")), "the OAuth client object")
    for (const member of [...objectMembers(webhook, "WebhookClient"), ...objectMembers(oauth, "OAuthClient")]) entries.push({ name: member.name, kind: "op", functions: [member.fn] })

    const analyzer = new RouteAnalyzer(program, { sinks: sdkSinks })
    return entries.map((entry) => {
        const routes = new Set()
        const unresolved = new Set()
        for (const fn of entry.functions) {
            const found = analyzer.routesOf(fn)
            found.routes.forEach((route) => routes.add(route))
            found.unresolved.forEach((item) => unresolved.add(item))
        }
        return { name: entry.name, kind: entry.kind, routes: [...routes].sort(), unresolved: [...unresolved].sort() }
    })
}
