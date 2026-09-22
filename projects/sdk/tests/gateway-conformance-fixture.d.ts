export interface ExpectedGatewayCommand {
    readonly op: number
    readonly token: string
    readonly sessionId?: string
    readonly sequence?: number
}

export interface ExpectedGatewayFrame {
    readonly op: number
    readonly type?: string
    readonly sequence?: number
}

export function assertGatewayCommand(actual: unknown, expected: ExpectedGatewayCommand): void

export function assertGatewayFrame(actual: unknown, expected: ExpectedGatewayFrame): void

export function createGatewayConformanceDriver(
    mode: "default" | "effect",
    sdk: object,
    origin: string,
    observed: unknown[],
): Promise<unknown>

export function runGatewayConformance<M extends "default" | "effect">(
    mode: M,
    moduleObject?: object,
): Promise<Readonly<{ mode: M; commands: number; delivered: number }>>
