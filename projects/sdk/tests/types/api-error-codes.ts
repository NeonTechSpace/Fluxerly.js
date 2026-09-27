// Compile-only check, run by the test typecheck: the public ApiErrorCode, ApiProviderCode and ApiValidationCode
// unions match the internal catalogs exactly, so a catalog change cannot leave the documented unions stale
import type { ApiErrorCode, ApiProviderCode, ApiValidationCode } from "../../src/index.js"
import type { apiErrorMappings, validationErrorMappings } from "../../src/api-errors.js"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

export type ApiErrorCodesMatch = Assert<Same<ApiErrorCode, (typeof apiErrorMappings)[ApiProviderCode]["code"]>>
export type ApiProviderCodesMatch = Assert<Same<ApiProviderCode, keyof typeof apiErrorMappings>>
export type ApiValidationCodesMatch = Assert<Same<ApiValidationCode, keyof typeof validationErrorMappings>>
