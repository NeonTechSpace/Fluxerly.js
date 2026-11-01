export const docsBase = "/docs/"

// Guide pages of the documentation website, by slug
export type GuideSlug =
    | "changelog"
    | "commands"
    | "core-concepts"
    | "effect-first-bot"
    | "faq"
    | "guilds-and-permissions"
    | "messages"
    | "quick-start"
    | "reliability"
    | "sharding"
    | "starter-lifetime"
    | "support-and-compatibility"
    | "testing"
    | "where-do-i"
    | "create-a-bot"
    | "effect-application-testing"
    | "logging"
    | "small-bot"
    | "effect-workflows"
    | "application-supervision"
    | "configuration"
    | "deploying"
    | "events-and-collectors"
    | "history-and-cache"

export function guide(slug: GuideSlug, section?: string): string {
    return `${docsBase}${slug}/${section ? `#${section}` : ""}`
}

export const links = {
    docs: "/docs/",
    apiReference: "/docs/api/",
    github: "https://github.com/NeonTechSpace/Fluxerly.js",
    license: "https://github.com/NeonTechSpace/Fluxerly.js/blob/main/LICENSE",
    npm: "https://www.npmjs.com/package/@neontechspace/fluxerly",
    changelog: "/docs/changelog/",
    securityPolicy: "https://github.com/NeonTechSpace/Fluxerly.js/security/policy",
    firstReply: "#first-reply",
    neonflux: "https://github.com/NeonTechSpace/NeonFlux",
    neonfluxHome: "https://neonflux.neontechspace.com",
} as const

// Until a Stable is out, npm's plain install isn't what the site describes, so the public build names the channel here
const packageSpec: string = import.meta.env.PUBLIC_PACKAGE_SPEC ?? "@neontechspace/fluxerly"

export const installCommand = `npm install ${packageSpec}`
export const initCommand = `npx ${packageSpec} init`

export const packageManagers = [
    { id: "npm", label: "npm", install: `npm install ${packageSpec}`, init: initCommand },
    { id: "pnpm", label: "pnpm", install: `pnpm add ${packageSpec}`, init: `pnpm dlx ${packageSpec} init` },
    { id: "bun", label: "Bun", install: `bun add ${packageSpec}`, init: `bunx ${packageSpec} init` },
] as const

export type PackageManager = (typeof packageManagers)[number]["id"]

// The feature pages, in the order the Discover menu lists them. Each summary is the page's one line of what it is
// for. Cyan is what you do, violet is what the SDK knows
export const featurePages = [
    {
        slug: "first-reply",
        title: "A Working Bot in One File",
        summary: "From an empty folder to a bot that answers, in one file that already reconnects and stops cleanly",
        accent: "cyan",
    },
    {
        slug: "effect",
        title: "Effect, When You Want It",
        summary: "Optional. The same SDK with typed failures and scoped cleanup",
        accent: "violet",
    },
    {
        slug: "results",
        title: "Read Every Failure",
        summary: "Requests return a Result to check, and the SDK repeats a write only after a rate limit",
        accent: "violet",
    },
    {
        slug: "commands",
        title: "Commands with the Plumbing Done",
        summary: "The router converts arguments, runs guards and cooldowns and builds the help from your definitions",
        accent: "cyan",
    },
    {
        slug: "logs",
        title: "See What a Bot Is Doing",
        summary: "Readable records from the first run, with error codes, hints and the token masked",
        accent: "violet",
    },
    {
        slug: "testing",
        title: "Tests Without a Token",
        summary: "A real client against an in-memory Fluxer, so tests run without a token or network access",
        accent: "violet",
    },
    {
        slug: "production",
        title: "A Bot That Stays Up",
        summary: "Sharding, session resume, a clean shutdown and a restarting supervisor are all in the SDK",
        accent: "cyan",
    },
    {
        slug: "data",
        title: "Reading and Caching Data",
        summary: "History reads, opt-in caches and collectors, with cached copies kept apart from fresh fetches",
        accent: "violet",
    },
] as const

export type FeatureSlug = (typeof featurePages)[number]["slug"]

// Effect's own introduction, for readers new to it
export const effectWebsite = "https://effect.website/docs/v4/getting-started/why-effect"
