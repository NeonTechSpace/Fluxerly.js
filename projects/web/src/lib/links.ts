import { installCommandFor } from "../../scripts/docs/install-command.mjs"

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
    | "production-checklist"
    | "raw-requests-and-events"

export function guide(slug: GuideSlug, section?: string): string {
    return `${docsBase}${slug}/${section ? `#${section}` : ""}`
}

export const links = {
    docs: "/docs/",
    playground: "/playground/",
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
const packageSpec: string = import.meta.env?.PUBLIC_PACKAGE_SPEC ?? "@neontechspace/fluxerly"

export const installCommand = installCommandFor("npm", packageSpec)
export const initCommand = `npx ${packageSpec} init`

export const packageManagers = [
    { id: "npm", label: "npm", install: installCommand, init: initCommand },
    { id: "pnpm", label: "pnpm", install: installCommandFor("pnpm", packageSpec), init: `pnpm dlx ${packageSpec} init` },
    { id: "bun", label: "Bun", install: installCommandFor("bun", packageSpec), init: `bunx ${packageSpec} init` },
] as const

export type PackageManager = (typeof packageManagers)[number]["id"]

// The feature pages, in the order the Discover menu lists them. Each summary is the page's one line of what it is
// for, while seoTitle and seoDescription carry Fluxer-native search metadata. Cyan is what you do, violet is what the SDK knows
export const featurePages = [
    {
        slug: "first-reply",
        title: "A Working Bot in One File",
        summary: "Go from an empty folder to a live Fluxer bot in one file, with reconnects, clean shutdown and clear failure hints built in",
        seoTitle: "Build Your First Fluxer Bot in One File · Fluxerly.js",
        seoDescription: "Start a Fluxer bot in one JavaScript or TypeScript file with runBot. Connects, reconnects, replies to !ping and stops cleanly on Ctrl+C",
        accent: "cyan",
    },
    {
        slug: "effect",
        title: "Effect, When You Want It",
        summary: "Optional. The same SDK with typed failures and scoped cleanup",
        seoTitle: "Effect API for Fluxer Bots · Fluxerly.js",
        seoDescription: "Optional native Effect 4 entry point for Fluxer bots with typed failures, scoped resource cleanup, Layers and structured concurrency",
        accent: "violet",
    },
    {
        slug: "results",
        title: "Read Every Failure",
        summary: "Every request returns a typed Result instead of crashing a handler, with plain fix hints and safe rate-limit retries",
        seoTitle: "Typed Results and Error Handling for Fluxer Bots · Fluxerly.js",
        seoDescription: "Network calls in Fluxerly.js return a Result for expected Fluxer failures, with orThrow when exceptions fit and safe rate-limit retries",
        accent: "violet",
    },
    {
        slug: "commands",
        title: "Commands with the Plumbing Done",
        summary: "Define each command once and get typed arguments, permission guards, cooldowns, usage errors and generated help out of the box",
        seoTitle: "Prefix Commands, Arguments and Guards for Fluxer · Fluxerly.js",
        seoDescription: "Built-in Fluxer bot prefix command router with typed arguments, permission guards, cooldowns, command groups and generated help pages",
        accent: "cyan",
    },
    {
        slug: "logs",
        title: "See What a Bot Is Doing",
        summary: "Know why a bot failed on the first run: Collapsed SDK stacks, exact permission hints, live debug levels and automatic token masking",
        seoTitle: "Structured Logging and Diagnostics for Fluxer Bots · Fluxerly.js",
        seoDescription: "Readable Fluxer bot logs from the first run with stable error codes, action hints, automatic token masking and runtime diagnostics",
        accent: "violet",
    },
    {
        slug: "testing",
        title: "Tests Without a Token",
        summary: "Test commands, rate limits, API failures and ten-minute timers in milliseconds against an in-memory Fluxer, with no token or network",
        seoTitle: "Test Fluxer Bots Without a Token or Network · Fluxerly.js",
        seoDescription: "Run real Fluxer bot tests against an in-memory Fluxer gateway and HTTP server with createTestBot, fixtures and a manual test clock",
        accent: "violet",
    },
    {
        slug: "production",
        title: "A Bot That Stays Up",
        summary: "Ship updates without dropping active work: Automatic sharding, session resume across restarts, graceful drain and a built-in supervisor",
        seoTitle: "Sharding, Supervision and Uptime for Fluxer Bots · Fluxerly.js",
        seoDescription: "Operate large Fluxer bots with automatic sharding, session resume across restarts, graceful shutdown, a process supervisor and metrics",
        accent: "cyan",
    },
    {
        slug: "data",
        title: "Reading and Caching Data",
        summary: "History reads, opt-in caches and collectors, with cached copies kept apart from fresh fetches",
        seoTitle: "Paged History, Caches and Collectors for Fluxer · Fluxerly.js",
        seoDescription: "Read Fluxer message history with async iterators, opt into bounded local caches and wait for replies or reactions with collectors",
        accent: "violet",
    },
    {
        slug: "raw",
        title: "Raw Access, Still Typed",
        summary: "Never wait on an SDK release for a Fluxer feature: Every bot route is typed from OpenAPI and brand-new endpoints still share retries and rate limits",
        seoTitle: "Typed Raw Fluxer REST and Gateway Access · Fluxerly.js",
        seoDescription: "Call any bot-accessible Fluxer HTTP route with typed Fluxer field names through client.rest.call and handle typed raw gateway events",
        accent: "cyan",
    },
] as const

export type FeatureSlug = (typeof featurePages)[number]["slug"]

// Effect's own introduction, for readers new to it
export const effectWebsite = "https://effect.website/docs/v4/getting-started/why-effect"
