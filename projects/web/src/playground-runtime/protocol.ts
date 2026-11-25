// Typed postMessage contract between the playground UI (parent) and the isolated sandbox iframe

export type SandboxMode = "default" | "effect"

export type SandboxFaultKind = "429" | "403" | "404" | "disconnect"

export interface SandboxConsoleEntry {
    readonly id: number
    readonly level: "log" | "info" | "warn" | "error"
    readonly text: string
    readonly timeMs: number
}

export interface SandboxLogEntry {
    readonly time: number
    readonly level: string
    readonly category: string
    readonly code: string
    readonly message: string
    readonly route?: string
    readonly status?: number
    readonly delayMs?: number
    readonly durationMs?: number
    readonly event?: string
    readonly command?: string
    readonly errorName?: string
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly errorHint?: string
}

export interface SandboxRestEntry {
    readonly index: number
    readonly method: string
    readonly path: string
    readonly matched: boolean
    readonly bodyPreview?: string
    readonly content?: string
    readonly hasEmbeds: boolean
}

export interface SandboxGatewayEntry {
    readonly index: number
    readonly op: number
    readonly opName: string
    readonly shardId: number | null
    readonly summary: string
}

export interface SandboxEmbedField {
    readonly name: string
    readonly value: string
    readonly inline: boolean
}

export interface SandboxEmbed {
    readonly title?: string
    readonly url?: string
    readonly description?: string
    readonly color?: number
    readonly authorName?: string
    readonly footerText?: string
    readonly timestamp?: string
    readonly fields: readonly SandboxEmbedField[]
}

export interface SandboxBotReply {
    readonly id: string
    readonly author: string
    readonly content: string
    readonly embeds: readonly SandboxEmbed[]
}

export interface SandboxCounters {
    readonly restRetries: number
    readonly rateLimitWaits: number
    readonly reconnects: number
    readonly resumes: number
    readonly commandRejections: number
    readonly handlerFailures: number
}

export interface SandboxTelemetry {
    readonly logs: readonly SandboxLogEntry[]
    readonly requests: readonly SandboxRestEntry[]
    readonly gateway: readonly SandboxGatewayEntry[]
    readonly counters: SandboxCounters
    readonly failures: number
}

export interface SandboxErrorPayload {
    readonly name: string
    readonly message: string
    readonly line?: number
    readonly column?: number
    readonly stack?: string
}

export type ParentToSandboxMessage =
    | {
          readonly type: "run"
          readonly runId: number
          readonly code: string
          readonly mode: SandboxMode
      }
    | {
          readonly type: "say"
          readonly requestId: number
          readonly content: string
          readonly authorName?: string
      }
    | {
          readonly type: "fault"
          readonly requestId: number
          readonly fault: SandboxFaultKind
      }
    | {
          readonly type: "clearFault"
          readonly requestId: number
      }
    | {
          readonly type: "dispose"
      }
    | {
          readonly type: "terminate"
      }
    | {
          readonly type: "restart"
      }

export type SandboxToParentMessage =
    | {
          readonly type: "booted"
          readonly bootMs: number
          readonly sdkVersion: string
      }
    | {
          readonly type: "console"
          readonly runId?: number
          readonly entry: SandboxConsoleEntry
      }
    | {
          readonly type: "runResult"
          readonly runId: number
          readonly ok: boolean
          readonly compileMs: number
          readonly runMs: number
          readonly interactive: boolean
          readonly botName: string
          readonly telemetry: SandboxTelemetry
          readonly error?: SandboxErrorPayload
      }
    | {
          readonly type: "sayResult"
          readonly requestId: number
          readonly ok: boolean
          readonly durationMs: number
          readonly replies: readonly SandboxBotReply[]
          readonly telemetry: SandboxTelemetry
          readonly error?: SandboxErrorPayload
      }
    | {
          readonly type: "faultResult"
          readonly requestId: number
          readonly ok: boolean
          readonly fault: SandboxFaultKind
          readonly note: string
          readonly telemetry: SandboxTelemetry
          readonly error?: SandboxErrorPayload
      }
    | {
          readonly type: "faultCleared"
          readonly requestId: number
          readonly note: string
          readonly telemetry: SandboxTelemetry
      }
