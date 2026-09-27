export type ModuleConformanceMode = "default" | "effect" | "testing" | "effectTesting"

export interface ModuleConformanceContract {
    readonly entrypoint: string
    readonly categories: Readonly<Record<string, readonly string[]>>
}

export const moduleConformance: Readonly<Record<ModuleConformanceMode, ModuleConformanceContract>>

export function expectedModuleExports(mode: ModuleConformanceMode): string[]

export function validateModuleConformance(
    mode: ModuleConformanceMode,
    moduleObject: object,
): Readonly<{ mode: ModuleConformanceMode; names: readonly string[] }>
