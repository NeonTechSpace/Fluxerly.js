import { ClientClosedError } from "#sdk/errors"

/** The failure for a REST call refused because the client is closed, before any request was sent */
export const closedBeforeSend = () => new ClientClosedError({ outcome: "notDispatched" })
