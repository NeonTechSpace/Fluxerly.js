export interface VoiceState {
    readonly channelId: string | null
    readonly muted: boolean
    readonly deafened: boolean
}

export function sameState(left: VoiceState | undefined, right: VoiceState | undefined): boolean
export function pendingResolution(
    current: VoiceState,
    pending: { readonly before: VoiceState; readonly intended: VoiceState },
): "intended" | "before" | "conflict"
export function rejoinedBaseline(current: VoiceState, baseline: VoiceState): boolean
