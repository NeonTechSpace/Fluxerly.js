// Where the live harnesses keep their shared state: the env file, sandbox locks, journals and pacing files. That is the
// SDK package folder. run-all.js runs harnesses from a private copy of the build and these harness files, so a rebuild
// of the repository cannot change code under a running check, and passes the real SDK folder in
// FLUXERLY_LIVE_STATE_ROOT so every copy still shares the same locks, journals and request budget
import { pathToFileURL } from "node:url"

/** The environment value that names the SDK folder holding live state, set by run-all.js for the harnesses it starts */
export const stateRootVariable = "FLUXERLY_LIVE_STATE_ROOT"

/** The SDK folder that holds live state, as a directory URL */
export const stateRoot = process.env[stateRootVariable]
    ? pathToFileURL(`${process.env[stateRootVariable].replace(/[\\/]+$/, "")}/`)
    : new URL("../../../", import.meta.url)
