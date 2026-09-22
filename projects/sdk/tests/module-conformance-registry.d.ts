export type ModuleConformanceMode = "default" | "effect"

export interface ModuleConformanceContract {
    readonly entrypoint: string
    readonly categories: Readonly<Record<string, readonly string[]>>
    readonly intentionalDifferences: Readonly<{
        onlyHere: readonly string[]
        onlyInOtherEntrypoint: readonly string[]
        rationale: string
    }>
}

export const moduleConformance: Readonly<Record<ModuleConformanceMode, ModuleConformanceContract>>

export function expectedModuleExports(mode: ModuleConformanceMode): string[]

export function validateModuleConformance(
    mode: ModuleConformanceMode,
    moduleObject: object,
): Readonly<{ mode: ModuleConformanceMode; names: readonly string[] }>
