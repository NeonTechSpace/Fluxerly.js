// The command that adds the SDK, for one package manager. A prerelease's API can change between versions, so its command
// saves the exact version, the way fluxerly init does, and a fresh install can't pick up a newer one that breaks the bot
const forms = {
    npm: { add: "npm install", exact: "--save-exact" },
    pnpm: { add: "pnpm add", exact: "--save-exact" },
    bun: { add: "bun add", exact: "--exact" },
}

const isPrerelease = (spec) => /@(?:nightly|[^@/]*-[^@/]*)$/.test(spec)

export const installCommandFor = (manager, spec) => `${forms[manager].add} ${isPrerelease(spec) ? `${forms[manager].exact} ` : ""}${spec}`
