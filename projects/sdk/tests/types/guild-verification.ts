import {
    GuildVerificationLevels,
    type GuildEdit,
    type GuildFeatureToggle,
    type GuildVerificationLevel,
} from "../../src/index.js"
import {
    GuildVerificationLevels as NativeGuildVerificationLevels,
    type GuildEdit as NativeGuildEdit,
    type GuildVerificationLevel as NativeGuildVerificationLevel,
} from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export const verificationRange: Assert<Equal<GuildVerificationLevel, 0 | 1 | 2 | 3>> = true
export const sameVerificationRange: Assert<Equal<NativeGuildVerificationLevel, GuildVerificationLevel>> = true
export const defaultHigh: GuildEdit = { verificationLevel: GuildVerificationLevels.High }
export const nativeHigh: NativeGuildEdit = { verificationLevel: NativeGuildVerificationLevels.High }
// @ts-expect-error Phone verification was removed from the default API constants
void GuildVerificationLevels.VeryHigh
// @ts-expect-error Phone verification was removed from the native API constants
void NativeGuildVerificationLevels.VeryHigh
// @ts-expect-error Level 4 is not a verification policy
export const retiredDefault: GuildEdit = { verificationLevel: 4 }
// @ts-expect-error Level 4 is not a verification policy in the native API
export const retiredNative: NativeGuildEdit = { verificationLevel: 4 }
// @ts-expect-error This observed provider feature cannot be toggled by a bot
export const observedFeature: GuildFeatureToggle = "ANNOUNCEMENT_CHANNELS_DISABLED"
