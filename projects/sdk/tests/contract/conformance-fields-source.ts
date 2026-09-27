import {
    API,
    ModifierFlags,
    NodeBuilderFlags,
    SignatureKind,
    SymbolFlags,
    type Project,
    type Symbol as TypeScriptSymbol,
    type Type,
    type NodeHandle,
} from "typescript/unstable/sync"
import { isTypeReferenceNode, type ModifiersBase, type Node } from "typescript/unstable/ast"

const displayFlags = NodeBuilderFlags.NoTruncation
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Exported client types whose members, and whose namespace-object members, form the public operation surface */
const rootClients = ["Client", "OAuthClient", "WebhookClient"] as const

export interface PublicObjectField {
    readonly key: string
    readonly owner: string
    readonly name: string
    readonly type: string
    readonly optional: boolean
    readonly nullable: boolean
}

export interface PublicObjectSchema {
    readonly name: string
    readonly owners: readonly string[]
    readonly fields: readonly PublicObjectField[]
    readonly variants: readonly string[]
}

export interface PublicOperationSchema {
    readonly key: string
    readonly signature: string
}

/** A non-callable client member, such as a namespace object or a local state value */
export interface PublicMemberSchema {
    readonly key: string
    readonly type: string
}

export interface PublicFieldInventories {
    readonly default: PublicFieldInventory
    readonly native: PublicFieldInventory
}

export interface PublicFieldInventory {
    readonly entrypoint: "src/index.ts" | "src/effect.ts"
    readonly members: readonly PublicMemberSchema[]
    readonly operations: Readonly<Record<string, PublicOperationSchema>>
    readonly objects: Readonly<Record<string, PublicObjectSchema>>
}

let publicFieldInventoryCache: PublicFieldInventories | undefined

// Splits the TypeScript checker's canonical typeToString display of a field type into its top-level union members, so
// field types are recorded in a stable member order
function splitTopLevel(value: string, separator: string): readonly string[] {
    const result: string[] = []
    let start = 0
    let round = 0
    let square = 0
    let curly = 0
    let angle = 0
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]
        if (character === "(") round += 1
        else if (character === ")") round -= 1
        else if (character === "[") square += 1
        else if (character === "]") square -= 1
        else if (character === "{") curly += 1
        else if (character === "}") curly -= 1
        else if (character === "<") angle += 1
        else if (character === ">" && value[index - 1] !== "=") angle -= 1
        else if (character === separator && round === 0 && square === 0 && curly === 0 && angle === 0) {
            result.push(value.slice(start, index).trim())
            start = index + 1
        }
    }
    result.push(value.slice(start).trim())
    return result.filter(Boolean)
}

function hasTopLevelUnionMember(type: string, member: "null" | "undefined"): boolean {
    return splitTopLevel(type, "|").some((part) => part === member)
}

function exportedSymbols(project: Project, entrypoint: "src/index.ts" | "src/effect.ts") {
    const source = project.program.getSourceFile(entrypoint)
    if (source === undefined) throw new Error(`${entrypoint} was not loaded`)
    const module = project.checker.getSymbolAtLocation(source)
    if (module === undefined) throw new Error(`${entrypoint} is not a module`)
    return new Map(project.checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]))
}

function resolvedSymbol(project: Project, symbol: TypeScriptSymbol): TypeScriptSymbol {
    return symbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol
}

const isSdkSourcePath = (path: string): boolean => /\/projects\/sdk\/src\//i.test(path)

// Well-known symbol members such as Symbol.asyncDispose are local lifetime hooks, not data fields, and their
// compiler-assigned names are not stable between runs
const isDataProperty = (property: TypeScriptSymbol): boolean => !property.name.startsWith("__@")

// Private and protected class members are implementation state that callers cannot read, not public fields
const isPublicDataProperty = (project: Project, property: TypeScriptSymbol): boolean =>
    isDataProperty(property) &&
    !property.declarations.some(
        (declaration) =>
            (((declaration.resolve(project) as Partial<ModifiersBase> | undefined)?.modifierFlags ??
                ModifierFlags.None) &
                (ModifierFlags.Private | ModifierFlags.Protected)) !==
            0,
    )

const isSdkDeclared = (symbol: TypeScriptSymbol): boolean =>
    symbol.declarations.some((declaration) => isSdkSourcePath(String(declaration.path)))

/** The SDK-declared data properties of an exported type's declared type, grouped by name across union variants */
function sdkProperties(project: Project, variants: readonly Type[]) {
    const byName = new Map<string, TypeScriptSymbol[]>()
    for (const variant of variants)
        for (const property of project.checker.getPropertiesOfType(variant))
            if (isPublicDataProperty(project, property))
                byName.set(property.name, [...(byName.get(property.name) ?? []), property])
    return [...byName]
        .filter(([, properties]) => properties.some(isSdkDeclared))
        .sort(([left], [right]) => compareText(left, right))
}

function declaredVariants(project: Project, exported: TypeScriptSymbol): readonly Type[] {
    const type = project.checker.getDeclaredTypeOfSymbol(resolvedSymbol(project, exported))
    return type.isUnionType() ? type.getTypes() : [type]
}

function objectSchema(project: Project, name: string, exported: TypeScriptSymbol): PublicObjectSchema | undefined {
    const declared = project.checker.getDeclaredTypeOfSymbol(resolvedSymbol(project, exported))
    const variants = declaredVariants(project, exported)
    const fields = sdkProperties(project, variants).map(([propertyName, properties]) => {
        const owners = [
            ...new Set(
                properties
                    .flatMap((property) => property.declarations)
                    .map((declaration) => String(declaration.path))
                    .filter(isSdkSourcePath)
                    .map((path) => path.replace(/^.*\/src\//, "src/")),
            ),
        ]
        const displayedTypes = properties.flatMap((property) => {
            const propertyType = project.checker.getTypeOfSymbol(property)
            if (propertyType === undefined) throw new Error(`${name}.${propertyName} has no type`)
            return splitTopLevel(project.checker.typeToString(propertyType, undefined, displayFlags), "|")
        })
        if (properties.length < variants.length) displayedTypes.push("undefined")
        const fieldType = [...new Set(displayedTypes)].sort(compareText).join(" | ")
        return Object.freeze({
            key: `${name}.${propertyName}`,
            name: propertyName,
            type: fieldType,
            optional: hasTopLevelUnionMember(fieldType, "undefined"),
            nullable: hasTopLevelUnionMember(fieldType, "null"),
            owner: owners.join("; "),
        })
    })
    if (fields.length === 0) return undefined
    return Object.freeze({
        name,
        owners: Object.freeze([...new Set(fields.flatMap((field) => field.owner.split("; ")))].sort()),
        fields: Object.freeze(fields),
        variants: Object.freeze(
            declared.isUnionType()
                ? declared
                      .getTypes()
                      .map((variant) => project.checker.typeToString(variant, undefined, displayFlags))
                      .sort(compareText)
                : [],
        ),
    })
}

/**
 * Walks checker types and collects every exported type name they reach. A type reaches the exported types named by
 * its alias or symbol, its type and alias arguments, its union and intersection members, and the parameters, type
 * parameter constraints and returns of its signatures. Anonymous and SDK-declared structural types are walked through
 * their properties and index signatures. An exported type is then expanded through its declared union variants and
 * SDK-declared properties. External library types such as Promise or Effect are walked only through their type
 * arguments. Visited type ids and collected names guard against cycles
 */
function reachableExportedTypes(project: Project, exports: ReadonlyMap<string, TypeScriptSymbol>) {
    const exportNames = new Map<number, string>()
    for (const name of [...exports.keys()].sort(compareText)) {
        const symbol = resolvedSymbol(project, exports.get(name)!)
        if (!exportNames.has(symbol.id)) exportNames.set(symbol.id, name)
    }
    const exportName = (type: Type): string | undefined => {
        const alias = type.getAliasSymbol()
        const aliased = alias === undefined ? undefined : exportNames.get(alias.id)
        if (aliased !== undefined) return aliased
        const symbol = type.getSymbol()
        return symbol === undefined ? undefined : exportNames.get(symbol.id)
    }
    const visitedTypes = new Set<number>()
    const names = new Set<string>()
    const pending: Type[] = []
    const visit = (type: Type | undefined): void => {
        if (type !== undefined) pending.push(type)
    }
    // The checker flattens a union alias written inside another union, or widened by an optional marker, into its
    // members, so the resolved type alone loses names such as AuditLogChangeValue in `newValue?: AuditLogChangeValue`.
    // Each type reference in an SDK declaration's own annotation is resolved separately to keep those aliases
    const visitAnnotation = (declaration: NodeHandle | undefined): void => {
        if (declaration === undefined || !isSdkSourcePath(String(declaration.path))) return
        const annotation = (declaration.resolve(project) as { readonly type?: Node } | undefined)?.type
        if (annotation === undefined) return
        const references: Node[] = []
        const collect = (node: Node): void => {
            if (isTypeReferenceNode(node)) references.push(node)
            node.forEachChild(collect)
        }
        collect(annotation)
        if (references.length > 0) for (const type of project.checker.getTypeAtLocation(references)) visit(type)
    }
    const visitSymbol = (symbol: TypeScriptSymbol): void => {
        visit(project.checker.getTypeOfSymbol(symbol))
        for (const declaration of symbol.declarations) visitAnnotation(declaration)
    }
    const visitSignatures = (type: Type): void => {
        for (const kind of [SignatureKind.Call, SignatureKind.Construct])
            for (const signature of project.checker.getSignaturesOfType(type, kind)) {
                for (const parameter of signature.getTypeParameters())
                    visit(project.checker.getConstraintOfTypeParameter(parameter))
                for (const parameter of signature.getParameters()) visitSymbol(parameter)
                visit(project.checker.getReturnTypeOfSignature(signature))
                visitAnnotation(signature.declaration)
            }
    }
    const visitStructure = (type: Type, properties: readonly TypeScriptSymbol[]): void => {
        for (const property of properties) visitSymbol(property)
        for (const index of project.checker.getIndexInfosOfType(type)) visit(index.valueType)
        visitSignatures(type)
    }
    const expand = (name: string): void => {
        if (names.has(name)) return
        names.add(name)
        const variants = declaredVariants(project, exports.get(name)!)
        for (const variant of variants) {
            if (variants.length > 1) visit(variant)
            for (const index of project.checker.getIndexInfosOfType(variant)) visit(index.valueType)
            visitSignatures(variant)
        }
        for (const [, properties] of sdkProperties(project, variants))
            for (const property of properties) visitSymbol(property)
    }
    const drain = (): void => {
        while (pending.length > 0) {
            const type = pending.pop()!
            if (visitedTypes.has(type.id)) continue
            visitedTypes.add(type.id)
            if (type.isIntrinsicType() || type.isLiteralType() || type.isTemplateLiteralType()) continue
            for (const argument of type.getAliasTypeArguments()) visit(argument)
            const name = exportName(type)
            if (name !== undefined) expand(name)
            if (type.isUnionType() || type.isIntersectionType()) {
                for (const member of type.getTypes()) visit(member)
                continue
            }
            if (type.isTypeParameter()) {
                visit(project.checker.getConstraintOfTypeParameter(type))
                continue
            }
            if (type.isIndexedAccessType()) {
                visit(type.getObjectType())
                visit(type.getIndexType())
                continue
            }
            if (type.isIndexType() || type.isStringMappingType()) {
                visit(type.getTarget())
                continue
            }
            if (type.isConditionalType()) {
                for (const branch of [
                    type.getCheckType(),
                    type.getExtendsType(),
                    type.getTrueType(),
                    type.getFalseType(),
                ])
                    visit(branch)
                continue
            }
            if (type.isSubstitutionType()) {
                visit(type.getBaseType())
                continue
            }
            if (type.isTypeReference()) for (const argument of project.checker.getTypeArguments(type)) visit(argument)
            if (name !== undefined || !type.isObjectType()) continue
            const symbol = type.getSymbol()
            if (symbol === undefined || symbol.name.startsWith("__") || isSdkDeclared(symbol))
                visitStructure(
                    type,
                    project.checker
                        .getPropertiesOfType(type)
                        .filter((property) => isPublicDataProperty(project, property)),
                )
        }
    }
    return {
        visit: (symbol: TypeScriptSymbol): void => {
            visitSymbol(symbol)
            drain()
        },
        names: (): readonly string[] => [...names].sort(compareText),
    }
}

/**
 * Reads every member of the root clients and of their namespace objects. A callable member is an operation keyed by
 * its owner type, such as Messages.fetch. Any other member is recorded with its displayed type, and a member typed by
 * an exported interface is walked as a namespace object
 */
function publicClientMembers(project: Project, exports: ReadonlyMap<string, TypeScriptSymbol>) {
    const operations = new Map<string, { readonly signature: string; readonly symbol: TypeScriptSymbol }>()
    const members: {
        readonly key: string
        readonly type: string
        readonly symbol: TypeScriptSymbol
        readonly namespace?: string
    }[] = []
    const queue: string[] = [...rootClients]
    const visited = new Set<string>()
    while (queue.length > 0) {
        const owner = queue.shift()!
        if (visited.has(owner)) continue
        visited.add(owner)
        const exported = exports.get(owner)
        if (exported === undefined) throw new Error(`${owner} is not exported`)
        const ownerType = project.checker.getDeclaredTypeOfSymbol(resolvedSymbol(project, exported))
        for (const member of project.checker.getPropertiesOfType(ownerType)) {
            if (!isPublicDataProperty(project, member)) continue
            const key = `${owner}.${member.name}`
            const memberType = project.checker.getTypeOfSymbol(member)
            if (memberType === undefined) throw new Error(`${key} has no type`)
            const display = project.checker.typeToString(memberType, undefined, displayFlags)
            if (project.checker.getSignaturesOfType(memberType, SignatureKind.Call).length > 0) {
                operations.set(key, { signature: display, symbol: member })
                continue
            }
            const namespace = memberType.getSymbol()?.name
            const isNamespace = namespace !== undefined && exports.has(namespace)
            members.push({ key, type: display, symbol: member, ...(isNamespace ? { namespace } : {}) })
            if (isNamespace) queue.push(namespace)
        }
    }
    return {
        operations: [...operations].sort(([left], [right]) => compareText(left, right)),
        members: members.sort((left, right) => compareText(left.key, right.key)),
    }
}

/**
 * Derives the current public operation, request and response shape of both entry points from the compiler's canonical
 * source model, loading the project once
 */
export function publicFieldInventories(): PublicFieldInventories {
    if (publicFieldInventoryCache !== undefined) return publicFieldInventoryCache
    const api = new API({ cwd: process.cwd() })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        if (project === undefined) throw new Error("TypeScript project was not loaded")
        publicFieldInventoryCache = Object.freeze({
            default: entrypointInventory(project, "src/index.ts"),
            native: entrypointInventory(project, "src/effect.ts"),
        })
        return publicFieldInventoryCache
    } finally {
        api.close()
    }
}

function entrypointInventory(project: Project, entrypoint: "src/index.ts" | "src/effect.ts"): PublicFieldInventory {
    const exports = exportedSymbols(project, entrypoint)
    const clientMembers = publicClientMembers(project, exports)
    const walker = reachableExportedTypes(project, exports)
    const operations: Record<string, PublicOperationSchema> = {}
    for (const [key, { signature, symbol }] of clientMembers.operations) {
        operations[key] = Object.freeze({ key, signature })
        walker.visit(symbol)
    }
    // Local state values such as Client.state are public shapes too. Namespace objects are covered by their operations
    for (const member of clientMembers.members) if (member.namespace === undefined) walker.visit(member.symbol)

    const objects: Record<string, PublicObjectSchema> = {}
    for (const name of walker.names()) {
        const schema = objectSchema(project, name, exports.get(name)!)
        if (schema !== undefined) objects[name] = schema
    }
    return Object.freeze({
        entrypoint,
        members: Object.freeze(clientMembers.members.map(({ key, type }) => Object.freeze({ key, type }))),
        operations: Object.freeze(operations),
        objects: Object.freeze(objects),
    })
}
