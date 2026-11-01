# Compatibility reviews

These are one-time reviews, run when someone asks for one. They go deeper than the [scheduled drift check](/docs/REPOSITORY.md#development-checks), which compares watched documents with the previous observation, falling back to the repository pin when needed

A review is research. It doesn't authorize dependency changes, SDK changes, bot sessions, publication or recurring work

Report the result in the issue or pull request that asked for it, including when nothing changed. Name the exact ranges reviewed, source hashes, dates, findings and anything left unfinished

## Fluxer compatibility

Find what changed in Fluxer since the last reviewed commit and what that means for bots using the SDK

1. Find Fluxer's current official repositories, branches and source paths first, because they move
2. Read the whole change range, commit by commit, so a removal that was later restored counts as one change
3. Check component releases and tags by publication order, not by name
4. Compare the API document and its schemas: Paths, authentication, parameters, response shapes, required and optional fields, enums and bit flags
5. Trace the gateway: Versions, encoding, opcodes, close codes, identify, heartbeats, resume, shards and events
6. Check behavior the schemas don't show: Rate limits, permissions, bot restrictions, normalization, uploads and pagination
7. Read related pull requests, issues, release notes and advisories
8. Check the affected SDK code before calling something affected or missing

Keep these states apart: Merged, released, served by an instance and seen working at runtime. Give every change a consequence for bots, a reason it has none, or mark it as unresolved

Move the [reviewed commit](/projects/release/upstream/manifest.json) only past a range that was fully reviewed. If part of a range is unavailable, say so rather than skipping to a newer commit

## Compiler compatibility

Find whether the [compilers in use](/docs/TECHNOLOGY.md) can move to a newer TypeScript version

1. List the tools that depend on the compiler from the manifests, lockfile, configuration and scripts
2. Check official release notes for each tool, including its compiler API and language server support
3. Keep these apart: Released support, a declared version range and a successful build of this project. A wider range alone proves neither of the others
4. Report each tool as compatible, blocked or unverified, with what's left to check

A result here doesn't authorize a migration, and it doesn't prove the project builds
