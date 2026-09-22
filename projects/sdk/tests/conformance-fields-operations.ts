import { operationConformance } from "./conformance-registry.js"
import {
    clientTopLevelOperationConformance,
    standaloneOperationConformance,
} from "./standalone-conformance-registry.js"

/** All registered provider REST and Client gateway operations in deterministic order. */
export const fieldOperationKeys = Object.freeze(
    Object.keys({
        ...operationConformance,
        ...standaloneOperationConformance,
        ...clientTopLevelOperationConformance,
    }).sort(),
)
