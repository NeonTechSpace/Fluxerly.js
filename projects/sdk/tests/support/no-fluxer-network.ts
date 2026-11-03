// No unit test may reach Fluxer. The guard makes such a request throw before it connects, and this hook fails the test
// that sent it even when the code under test caught the error. The live tests talk to Fluxer through their own commands
import { afterEach } from "vitest"
import { blockedFluxerRequests } from "../../../scripts/no-fluxer-network.mjs"

afterEach(() => {
    const blocked = blockedFluxerRequests.splice(0)
    if (blocked.length)
        throw new Error(
            `This test tried to reach Fluxer at ${blocked.join(", ")}. Give it a fake transport or a local server`,
        )
})
