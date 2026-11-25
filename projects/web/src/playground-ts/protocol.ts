// Typed message protocol between the main-thread CodeMirror editor and the static TypeScript 6.0 Web Worker

export interface TsAssetManifest {
    readonly workerUrl: string
    readonly coreTypesUrl: string
    readonly effectTypesUrl: string
}

export interface TsDiagnostic {
    readonly from: number
    readonly to: number
    readonly message: string
    readonly code: number
    readonly severity: "error" | "warning"
}

export interface TsCompletionItem {
    readonly label: string
    readonly kind: string
    readonly sortText: string
    readonly insertText?: string
    readonly replaceFrom?: number
    readonly replaceTo?: number
    readonly source?: string
    readonly detail?: string
    readonly isRecommended?: boolean
}

export interface TsDocTag {
    readonly name: string
    readonly text: string
}

export interface TsCompletionDetails {
    readonly display: string
    readonly documentation: string
    readonly tags: readonly TsDocTag[]
}

export interface TsQuickInfo {
    readonly from: number
    readonly to: number
    readonly display: string
    readonly documentation: string
    readonly tags: readonly TsDocTag[]
}

export type MainToTsWorkerMessage =
    | {
          readonly type: "init"
          readonly coreTypesUrl: string
          readonly effectTypesUrl: string
          readonly coreBuffer?: ArrayBuffer
          readonly fileName: string
          readonly code: string
          readonly version?: number
      }
    | {
          readonly type: "update"
          readonly fileName: string
          readonly code: string
          readonly version: number
      }
    | {
          readonly type: "complete"
          readonly id: number
          readonly fileName: string
          readonly offset: number
          readonly triggerCharacter?: string
          readonly explicit: boolean
      }
    | {
          readonly type: "completionDetails"
          readonly id: number
          readonly fileName: string
          readonly offset: number
          readonly name: string
          readonly source?: string
      }
    | {
          readonly type: "hover"
          readonly id: number
          readonly fileName: string
          readonly offset: number
      }
    | {
          readonly type: "diagnostics"
          readonly id: number
          readonly fileName: string
          readonly version: number
      }

export type TsWorkerToMainMessage =
    | {
          readonly type: "ready"
          readonly bootMs: number
          readonly fileCount: number
          readonly hasEffect: boolean
          readonly fileName: string
          readonly version: number
          readonly diagnostics: readonly TsDiagnostic[]
      }
    | {
          readonly type: "effectLoaded"
          readonly loadMs: number
          readonly fileCount: number
      }
    | {
          readonly type: "error"
          readonly message: string
      }
    | {
          readonly type: "completeResult"
          readonly id: number
          readonly from: number
          readonly to: number
          readonly items: readonly TsCompletionItem[]
          readonly isIncomplete?: boolean
      }
    | {
          readonly type: "completionDetailsResult"
          readonly id: number
          readonly details: TsCompletionDetails | null
      }
    | {
          readonly type: "hoverResult"
          readonly id: number
          readonly info: TsQuickInfo | null
      }
    | {
          readonly type: "diagnosticsResult"
          readonly id: number
          readonly fileName: string
          readonly version: number
          readonly diagnostics: readonly TsDiagnostic[]
      }
