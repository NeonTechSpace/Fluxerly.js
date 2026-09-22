import {
    API,
    NodeBuilderFlags,
    SymbolFlags,
    type Project,
    type Symbol as TypeScriptSymbol,
} from "typescript/unstable/sync"

const displayFlags = NodeBuilderFlags.NoTruncation
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

// This is intentionally a parser for the TypeScript 7 checker's canonical typeToString display, not arbitrary
// TypeScript source. Balanced delimiters and top-level arrows/unions are the supported grammar; an unrecognized
// operation signature throws instead of producing a partial inventory.

export interface PublicParameterField {
    readonly name: string
    readonly type: string
    readonly optional: boolean
    readonly nullable: boolean
}

export interface PublicObjectField extends PublicParameterField {
    readonly key: string
    readonly owner: string
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
    readonly parameters: readonly PublicParameterField[]
    readonly requestTypes: readonly string[]
    readonly successType: string
    readonly responseTypes: readonly string[]
}

export interface PublicFieldInventory {
    readonly entrypoint: "src/index.ts" | "src/effect.ts"
    readonly operations: Readonly<Record<string, PublicOperationSchema>>
    readonly objects: Readonly<Record<string, PublicObjectSchema>>
}

export interface ReachableFieldInventory {
    readonly parameters: readonly string[]
    readonly fields: readonly PublicObjectField[]
    readonly objectNames: readonly string[]
}

export interface PublicOperationParameter extends PublicParameterField {
    readonly key: string
    readonly operation: string
}

const publicFieldInventoryCache = new Map<string, PublicFieldInventory>()

function topLevelArrow(signature: string): number {
    let round = 0
    let square = 0
    let curly = 0
    let angle = 0
    for (let index = 0; index < signature.length - 1; index += 1) {
        const character = signature[index]
        if (character === "(") round += 1
        else if (character === ")") round -= 1
        else if (character === "[") square += 1
        else if (character === "]") square -= 1
        else if (character === "{") curly += 1
        else if (character === "}") curly -= 1
        else if (character === "<") angle += 1
        else if (character === ">" && signature[index - 1] !== "=") angle -= 1
        else if (
            character === "=" &&
            signature[index + 1] === ">" &&
            round === 0 &&
            square === 0 &&
            curly === 0 &&
            angle === 0
        )
            return index
    }
    return -1
}

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

function parseParameters(signature: string): readonly PublicParameterField[] {
    const arrow = topLevelArrow(signature)
    if (arrow < 0) throw new Error(`Unparsed operation signature: ${signature}`)
    const open = signature.indexOf("(")
    const close = signature.lastIndexOf(")", arrow)
    if (open < 0 || close < open) throw new Error(`Unparsed operation parameters: ${signature}`)
    return splitTopLevel(signature.slice(open + 1, close), ",").map((parameter) => {
        const [rawName = "", ...typeParts] = splitTopLevel(parameter, ":")
        const type = typeParts.join(": ").trim()
        return Object.freeze({
            name: rawName.replace(/^\.\.\./, "").replace(/\?$/, ""),
            type,
            optional: rawName.endsWith("?") || hasTopLevelUnionMember(type, "undefined"),
            nullable: hasTopLevelUnionMember(type, "null"),
        })
    })
}

function hasTopLevelUnionMember(type: string, member: "null" | "undefined"): boolean {
    return splitTopLevel(type, "|").some((part) => part === member)
}

function firstTypeArgument(type: string): string | undefined {
    const open = type.indexOf("<")
    if (open < 0 || !type.endsWith(">")) return undefined
    return splitTopLevel(type.slice(open + 1, -1), ",")[0]
}

function successType(signature: string): string {
    const arrow = topLevelArrow(signature)
    if (arrow < 0) throw new Error(`Unparsed operation return type: ${signature}`)
    const returned = signature.slice(arrow + 2).trim()
    return /^(?:Result|ResultAsync|(?:Effect\.)?Effect|(?:Stream\.)?Stream)</.test(returned)
        ? (firstTypeArgument(returned) ?? returned)
        : returned
}

function referencedNames(type: string, exports: ReadonlyMap<string, TypeScriptSymbol>): readonly string[] {
    return Object.freeze(
        [...new Set(type.match(/\b[A-Z][A-Za-z0-9_]*/g) ?? [])].filter((name) => exports.has(name)).sort(compareText),
    )
}

function responseRootNames(
    operation: string,
    type: string,
    exports: ReadonlyMap<string, TypeScriptSymbol>,
): readonly string[] {
    if (/^(?:AsyncIterable|ReadonlyArray|Array|Result)\s*</.test(type)) {
        const item = firstTypeArgument(type)
        if (item === undefined) throw new Error(`Unparsed generic response type: ${type}`)
        return responseRootNames(operation, item, exports)
    }
    const localHandle = type.match(/^(Collector|ReactionCollector|EventSubscription|Subscription|Pagination)\b/)
    if (localHandle && exports.has(localHandle[1]!)) return [localHandle[1]!]
    const names = [...referencedNames(type, exports)]
    if (/\bM\b/.test(type)) {
        const usesDefaultMessageGeneric =
            operation.startsWith("Messages.") ||
            operation.startsWith("DirectMessages.") ||
            operation === "Client.waitFor" ||
            operation === "Client.events"
        if (!usesDefaultMessageGeneric)
            throw new Error(`Unclassified generic response parameter in ${operation}: ${type}`)
        if (!exports.has("Message")) throw new Error(`${operation} default Message export is missing`)
        // These public interfaces declare M extends MessageCore = Message. Index the default full response while the
        // generic signature itself remains in the operation inventory for selected-field consumers.
        names.push("Message")
    }
    return Object.freeze([...new Set(names)].sort(compareText))
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

function objectSchema(
    project: Project,
    exports: ReadonlyMap<string, TypeScriptSymbol>,
    name: string,
): PublicObjectSchema | undefined {
    const exported = exports.get(name)
    if (exported === undefined) return undefined
    const type = project.checker.getDeclaredTypeOfSymbol(resolvedSymbol(project, exported))
    if (type === undefined) return undefined
    const variants = type.isUnionType() ? type.getTypes() : [type]
    const propertyNames = [
        ...new Set(
            variants.flatMap((variant) =>
                project.checker.getPropertiesOfType(variant).map((property) => property.name),
            ),
        ),
    ].sort(compareText)
    if (propertyNames.length === 0) return undefined
    const fields = propertyNames.flatMap((propertyName) => {
        const properties = variants.flatMap((variant) => {
            const property = project.checker
                .getPropertiesOfType(variant)
                .find((candidate) => candidate.name === propertyName)
            return property === undefined ? [] : [property]
        })
        const owners = [
            ...new Set(
                properties
                    .flatMap((property) => property.declarations)
                    .map((declaration) => String(declaration.path))
                    .filter((path) => /\/projects\/sdk\/src\//i.test(path))
                    .map((path) => path.replace(/^.*\/src\//, "src/")),
            ),
        ]
        if (owners.length === 0) return []
        const displayedTypes = properties.flatMap((property) => {
            const propertyType = project.checker.getTypeOfSymbol(property)
            if (propertyType === undefined) throw new Error(`${name}.${propertyName} has no type`)
            return splitTopLevel(project.checker.typeToString(propertyType, undefined, displayFlags), "|")
        })
        if (properties.length < variants.length) displayedTypes.push("undefined")
        const fieldType = [...new Set(displayedTypes)].sort(compareText).join(" | ")
        return [
            Object.freeze({
                key: `${name}.${propertyName}`,
                name: propertyName,
                type: fieldType,
                optional: hasTopLevelUnionMember(fieldType, "undefined"),
                nullable: hasTopLevelUnionMember(fieldType, "null"),
                owner: owners.join("; "),
            }),
        ]
    })
    if (fields.length === 0) return undefined
    return Object.freeze({
        name,
        owners: Object.freeze([...new Set(fields.flatMap((field) => field.owner.split("; ")))].sort()),
        fields: Object.freeze(fields.sort((left, right) => compareText(left.key, right.key))),
        variants: Object.freeze(
            type.isUnionType()
                ? type
                      .getTypes()
                      .map((variant) => project.checker.typeToString(variant, undefined, displayFlags))
                      .sort(compareText)
                : [],
        ),
    })
}

/**
 * Derives the current public request/response shape from the compiler's canonical source model.
 * Bounds, defaults and normalization are deliberately kept in authored field-rule annotations.
 */
export function publicFieldInventory(
    entrypoint: "src/index.ts" | "src/effect.ts",
    operationKeys: readonly string[],
): PublicFieldInventory {
    const cacheKey = `${entrypoint}\0${operationKeys.join("\0")}`
    const cached = publicFieldInventoryCache.get(cacheKey)
    if (cached !== undefined) return cached
    const api = new API({ cwd: process.cwd() })
    try {
        const snapshot = api.updateSnapshot({ openProjects: ["tsconfig.json"] })
        const project = snapshot.getProjects().find((candidate) => candidate.configFileName.endsWith("/tsconfig.json"))
        if (project === undefined) throw new Error("TypeScript project was not loaded")
        const exports = exportedSymbols(project, entrypoint)
        const operations: Record<string, PublicOperationSchema> = {}
        const referenced = new Set<string>()
        for (const key of operationKeys) {
            const separator = key.indexOf(".")
            const namespace = key.slice(0, separator)
            const memberName = key.slice(separator + 1)
            const namespaceExport = exports.get(namespace)
            if (namespaceExport === undefined) throw new Error(`${entrypoint} does not export ${namespace}`)
            const namespaceType = project.checker.getDeclaredTypeOfSymbol(resolvedSymbol(project, namespaceExport))
            if (namespaceType === undefined) throw new Error(`${entrypoint} ${namespace} has no declared type`)
            const member = project.checker
                .getPropertiesOfType(namespaceType)
                .find((candidate) => candidate.name === memberName)
            if (member === undefined) throw new Error(`${entrypoint} does not expose ${key}`)
            const memberType = project.checker.getTypeOfSymbol(member)
            if (memberType === undefined) throw new Error(`${entrypoint} ${key} has no type`)
            const signature = project.checker.typeToString(memberType, undefined, displayFlags)
            const parameters = parseParameters(signature)
            const returned = successType(signature)
            const requestTypes = referencedNames(
                parameters
                    .filter((parameter) => !parameter.type.includes("=>"))
                    .map((parameter) => parameter.type)
                    .join(" | "),
                exports,
            )
            const responseTypes = responseRootNames(key, returned, exports)
            for (const name of [...requestTypes, ...responseTypes]) referenced.add(name)
            operations[key] = Object.freeze({
                key,
                signature,
                parameters,
                requestTypes,
                successType: returned,
                responseTypes,
            })
        }

        const objects: Record<string, PublicObjectSchema> = {}
        const queue = [...referenced]
        while (queue.length > 0) {
            const name = queue.shift()!
            if (objects[name] !== undefined) continue
            const schema = objectSchema(project, exports, name)
            if (schema === undefined) continue
            objects[name] = schema
            for (const variant of schema.variants)
                for (const referencedName of referencedNames(variant, exports))
                    if (objects[referencedName] === undefined) queue.push(referencedName)
            for (const field of schema.fields)
                for (const referencedName of referencedNames(field.type, exports))
                    if (objects[referencedName] === undefined) queue.push(referencedName)
        }
        const inventory = Object.freeze({
            entrypoint,
            operations: Object.freeze(operations),
            objects: Object.freeze(objects),
        })
        publicFieldInventoryCache.set(cacheKey, inventory)
        return inventory
    } finally {
        api.close()
    }
}

/** Returns the exact shared type fields reachable from one operation direction. */
export function reachablePublicFields(
    inventory: PublicFieldInventory,
    direction: "request" | "response",
): ReachableFieldInventory {
    const parameters =
        direction === "request"
            ? Object.values(inventory.operations).flatMap((operation) =>
                  operation.parameters.map((parameter) => `${operation.key}(${parameter.name})`),
              )
            : Object.values(inventory.operations)
                  .filter((operation) => operation.responseTypes.length === 0)
                  .map((operation) => `${operation.key}(return)`)
    const roots = Object.values(inventory.operations).flatMap((operation) =>
        direction === "request"
            ? operation.requestTypes
            : operation.responseTypes.filter((name) => name !== "EventMap"),
    )
    return reachablePublicFieldsFromRoots(inventory, roots, parameters)
}

/** Returns the public gateway payload fields reachable through the supported EventMap. */
export function reachableGatewayPublicFields(inventory: PublicFieldInventory): ReachableFieldInventory {
    const exposesEvents = Object.values(inventory.operations).some((operation) =>
        operation.responseTypes.includes("EventMap"),
    )
    return reachablePublicFieldsFromRoots(inventory, exposesEvents ? ["EventMap"] : [], [])
}

function reachablePublicFieldsFromRoots(
    inventory: PublicFieldInventory,
    roots: readonly string[],
    parameters: readonly string[],
): ReachableFieldInventory {
    const queue = [...roots]
    const visited = new Set<string>()
    const fields = new Map<string, PublicObjectField>()
    while (queue.length > 0) {
        const name = queue.shift()!
        if (visited.has(name)) continue
        visited.add(name)
        const object = inventory.objects[name]
        if (object === undefined) continue
        for (const field of object.fields) {
            fields.set(field.key, field)
            if (field.type.includes("=>")) continue
            for (const nested of referencedNames(
                field.type,
                new Map(Object.keys(inventory.objects).map((key) => [key, {} as TypeScriptSymbol])),
            ))
                if (!visited.has(nested)) queue.push(nested)
        }
    }
    return Object.freeze({
        parameters: Object.freeze([...new Set(parameters)].sort()),
        fields: Object.freeze([...fields.values()].sort((left, right) => compareText(left.key, right.key))),
        objectNames: Object.freeze(
            [...visited].filter((name) => inventory.objects[name] !== undefined).sort(compareText),
        ),
    })
}

/** Direct operation parameters whose contract is not represented by a recursively indexed public object type. */
export function directPublicOperationParameters(inventory: PublicFieldInventory): readonly PublicOperationParameter[] {
    const objectNames = new Set(Object.keys(inventory.objects))
    return Object.freeze(
        Object.values(inventory.operations)
            .flatMap((operation) =>
                operation.parameters
                    .filter((parameter) => {
                        const names = parameter.type.match(/\b[A-Z][A-Za-z0-9_]*/g) ?? []
                        return !names.some((name) => objectNames.has(name))
                    })
                    .flatMap((parameter) => {
                        if (parameter.type.startsWith("{") && parameter.type.endsWith("}"))
                            return splitTopLevel(parameter.type.slice(1, -1), ";").map((part) => {
                                const [rawName = "", ...typeParts] = splitTopLevel(part, ":")
                                const name = rawName.replace(/^readonly\s+/, "").replace(/\?$/, "")
                                const type = typeParts.join(": ").trim()
                                return Object.freeze({
                                    name,
                                    type,
                                    optional: rawName.endsWith("?") || hasTopLevelUnionMember(type, "undefined"),
                                    nullable: hasTopLevelUnionMember(type, "null"),
                                    key: `${operation.key}(${parameter.name}.${name})`,
                                    operation: operation.key,
                                })
                            })
                        return [
                            Object.freeze({
                                ...parameter,
                                key: `${operation.key}(${parameter.name})`,
                                operation: operation.key,
                            }),
                        ]
                    }),
            )
            .sort((left, right) => compareText(left.key, right.key)),
    )
}
