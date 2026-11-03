# Live sandbox checks

These opt-in checks run the built SDK against the hosted Fluxer service, using one designated test bot, application and sandbox server.
They are excluded from `pnpm check`, CI, schedules and unattended runs.
A passing run establishes only its checked scenarios, not complete replay, prolonged-outage recovery or production readiness

## Setup

The Git-ignored `projects/sdk/.env.test.local` must provide `FLUXER_TEST_GUILD_ID`, `FLUXER_TEST_APPLICATION_ID` and `FLUXER_TEST_BOT_TOKEN`.
The harnesses verify bot, application and server identity before live requests.
Never print credentials or private payloads when diagnosing a failure

Run a package script from [projects/](/projects/) as `pnpm --filter @neontechspace/fluxerly <script>`. Most package scripts build the SDK first.
Run a direct harness command from `projects/sdk/` after building with `pnpm --filter @neontechspace/fluxerly build`

Some checks need a target ID or opt-in value from the process environment.
Values marked process-only are never read from the env file. Where a harness also accepts the env file, the process environment takes precedence.
A stored value is never authorization for a new run

## Authorization

Each check below lists one of these levels, derived from its target and outside effects

| Level          | Meaning                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SDK work       | Automated runs may perform the check during authorized SDK work. It uses the designated sandbox and test-owned resources only |
| Per run        | Each invocation needs specific authorization for its target or effect, supplied through the listed environment values         |
| Person present | A consenting person must act or stay available during the run, for example to approve consent, change status, type or rejoin  |

No level authorizes other servers or accounts, publication, schedules or unattended reruns

## If a check fails

A failed check can leave a `.env.test.*.local` journal in `projects/sdk/`. Do not delete it.
Rerun the same script. That run only cleans up and stops before the second API mode, with exit code 3.
When cleanup is verified, run it again for a real test.
A reported conflict needs manual inspection of the sandbox first

The [sandbox lock](/projects/sdk/tests/live/README.md#running-checks-together) prevents conflicting harness runs, not sessions started by other tools.
After a crash, confirm that the process recorded in a `.env.test.local.lock` or `.env.test.local.lock.<check>` file has stopped before removing that stale file.
Never bypass a live owner's lock or stop unrelated processes

OAuth checks keep tokens only in memory, and leaving a guild cannot be undone by a harness.
Follow [OAuth consent](/projects/sdk/tests/live/README.md#oauth-consent) and [leaving a guild](/projects/sdk/tests/live/README.md#member-changes-moderation-and-leaving-a-guild) for their manual recovery.
The [journal rules](/projects/sdk/tests/live/README.md#journals-and-restoration) explain where each harness documents what its journal records and restores.
Report the scenarios that ran and any mutation paths left untested

## Running checks together

Each harness scenario declares a lock class in [check classes](/projects/sdk/tests/live/support/check-classes.js), and a harness refuses to start without one

| Class          | Meaning                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`    | No writes to the sandbox                                                                                                                      |
| `test-owned`   | Creates and changes only its own temporary resources, and reads nothing that other checks change                                              |
| `shared-state` | Changes state other checks can observe, such as server settings or the bot's roles, or asserts over guild-wide state that other checks change |

Read-only and test-owned checks share the sandbox lock, so several can run at once. Each one holds its own `.env.test.local.lock.<check>` file, which also keeps a second run of the same check, and its journal, out.
A shared-state check holds `.env.test.local.lock` exclusively and starts only when no other check holds a lock.
A refused check fails with `sandbox_lock` instead of waiting

The runner, `pnpm --filter @neontechspace/fluxerly test:live:all <category or check>...`, runs [categories](/projects/sdk/tests/live/README.md#categories), named checks, the categories that changed files need, or for a release every SDK-work check below, including the SDK-work direct harness commands except `gateway-capture.js --write`, which rewrites a fixture.
It compiles the SDK sources once into a private copy in its log directory and runs every harness from there. It never writes the repository's `dist` folder, so a run holds no build lock and a rebuild during the run cannot change code under a running check. Only the compile, a few seconds, reads the sources, and `--build-lock <file>` holds an flock on a coordinating file for just that long. Locks, journals and pacing stay in the SDK folder.
It runs the shared-state checks one at a time first, then the others on two lanes unless `--concurrency` says otherwise.
Every check shares the one pacer, so a second lane sends no more requests a minute. The first lane starts with the checks that mostly wait on Fluxer, such as `recovery-window` and the forced resumes, and the other lane's paced requests fill those waits.
Before the run starts any check, it verifies bot, application and server identity once. Harnesses that need only the bot ID accept that verification for the same env file instead of repeating the three reads, and every harness started by hand still makes them.
Name categories or checks to run only those, for example `test:live:all reactions uploads`. A name that is both a category and a check runs the category. Package scripts are named without their `test:live:` prefix, `test:live` is `sandbox`, and direct commands are named after their harness file and flag, such as `bot-runner` or `recovery-window-session-restart`.
The runner refuses Per run and Person present checks, and passes no `FLUXER_TEST_` process values, so checks read only the env file

| Option                  | Effect                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--changed`             | Runs the categories the files changed since `--base` need, by default since HEAD left the pushed `main`, committed or not                                                                                                                                                           |
| `--base <ref>`          | The Git ref `--changed` compares with                                                                                                                                                                                                                                               |
| `--full`                | Runs every category that has not passed on the same inputs within 14 days, for a release only                                                                                                                                                                                       |
| `--build-lock <file>`   | Holds an flock on this file while compiling the private build copy, and only then                                                                                                                                                                                                   |
| `--concurrency <n>`     | Lanes for shared-lock checks, 2 by default. The first lane takes the checks that mostly wait                                                                                                                                                                                        |
| `--calibrated-pace`     | Uses the pace a recent [calibration](/projects/sdk/tests/live/README.md#pace-calibration) stored instead of 750 ms, and refuses to start without one from the last 14 days                                                                                                          |
| `--timeout-minutes <n>` | Stops a harness process after this time, 25 minutes by default, multiplied for checks that run together and never before the harness's own watchdog plus one minute. Its lock file stays behind as a stale lock, so the runner starts no further checks and records them as skipped |
| `--out <directory>`     | Log directory. By default a new `fluxerly-live-<time>` directory in the system temp folder                                                                                                                                                                                          |
| `--list`                | Prints the categories and every check, or with a selection the checks it would run, and sends nothing                                                                                                                                                                               |
| `--help`                | Prints the usage                                                                                                                                                                                                                                                                    |

Each check writes `<check>.log` and the run writes `summary.txt` with results, durations, request counts, hosted 429s and any remaining lock files or journals.
`timeline.jsonl` records when the build and each harness command started and ended, and `<check>.stages.jsonl` the time of each stage line a harness printed, with only its mode, stage name and outcome.
A check whose journal existed when the run started only cleans up, so the summary lists it as recovered rather than passed, and it needs another run to be tested.
The exit code is nonzero when a check fails, is skipped or only recovered, the run was throttled, or a lock file or journal remains.
Every check shares one request budget. Beyond the per-route limits, Fluxer has answered any route with a plain-text 429 and `Retry-After: 5` after a burst of requests, and kept refusing for a while. Its threshold and window are not known, so the harness paces itself instead of relying on them.
Runs with a concurrency of 2 and 4 reached that limit within minutes before the shared pacer existed, when each check paced only itself. With the shared pacer, more lanes add no requests a minute, only contention for paced slots, so lanes beyond two gain little.
When a check fails only when run together with others, declare it `shared-state` instead of weakening its assertions

### Request pacing and the stop rule

Every live HTTP request passes through one shared pacer in `support/live-pacing.js`: The raw helper's setup, readback and cleanup requests, the SDK's own requests inside harness processes, discovery, asset reads and supervised children. Requests to local loopback servers are not paced.

- Request starts are spaced by at least 750 ms, at most 80 starts a minute, with no initial burst. Set `FLUXERLY_LIVE_PACE_MS` to change the interval
- The pacing state lives in `.env.test.pace.json` in the SDK folder, so it carries across the default and Effect modes, across the checks the runner starts and into the next run. Its `.env.test.pace.json.lock` file is created like the sandbox lock and never removed for another process. If one stays behind, confirm the process it records has stopped before removing it
- A hosted 429 pauses every sender for at least its `Retry-After`, or one minute when it gives none, and marks the run throttled. A sender already waiting for its slot checks again before it starts and waits out the new pause too, while a request already sent cannot be held back. The running check finishes, and its cleanup goes through the same pacer or stays in its journal. The runner then starts no further check, lists the rest as skipped and reports the run as throttled. Wait before the next run
- A sender that would have to wait more than ten seconds for a pause stops with `LiveThrottledError` instead. The raw helper waits out a `Retry-After` of up to ten seconds, in seconds or as an HTTP date, and stops on a longer or missing one, never returning the 429 as an ordinary status
- The 429s that harnesses inject themselves, such as in `test:live:rate-limits`, replace fetch above the pacer, so they neither pause senders nor throttle the run
- Each check's requests are logged to `<check>.requests.jsonl` next to its log, and a single harness run logs to a `fluxerly-live-requests` folder in the system temp folder. A line holds the start time (`at`), when the sender was ready (`readyAt`), how long it waited for its slot (`waitMs`), how long the response headers took (`ms`), the process ID, the sender (`raw` or `sdk`), the method, the host and path with IDs and tokens replaced, the status and only the rate-limit headers. It never holds tokens, bodies or other headers

- Harness watchdogs (`process_timeout`) are sized in `support/watchdogs.js` from the pacing: The harness's base time plus every request its scenario can start, as counted from its source, times the pace interval, with a quarter more as margin and room for one ten-second pause. When checks run together, the runner passes their number and each request may wait behind five reserved requests of every other check. Update a harness's count there when its requests change
- Checks that time SDK requests, such as the typing refresh, bucket learning and rate-limit checks, observe fetch above the pacer, so they see when the SDK called and not when the pacer let the request go. Pacing only adds to the spacing they measure. Member request pacing applies to gateway requests, which the pacer does not see

Do not send manual requests with the sandbox bot's token, or run another live suite or bot on the same account or network, while a live run is in progress. They spend the same limit without passing through the pacer

### Categories

During work, run only the categories that cover the change, never the full suite. Each category finishes in about three minutes or less at the safe pace, with both APIs.
`test:live:all -- --changed` picks them from the files changed since HEAD left the pushed `main`, committed or not, and `--list` shows the pick without sending anything.
SDK source files select their area's categories, a changed harness selects the categories that hold its checks, and a source file outside every area, the live support code, the runner, `messages.js`, `command-conveniences.js` or the SDK manifest selects `smoke`. Changes to documentation, the website, release tooling or offline tests run nothing live.
`smoke` is the quick confidence check: Sending, receiving and replying, filtered event waits, discovery, the SDK's own rate-limit handling and a forced resume with its heartbeat. It does not cover the other resources, uploads, long recovery windows or most failure paths

A check that alone takes longer than a category may is split by API mode, as `<check>@default` and `<check>@effect` in two categories. Selecting both halves runs the whole check, its modes one after the other. `recovery-window` keeps all its state in its own process and sockets, so it declares a lock per mode and its two 165-second observation windows run at once

The times below replay the request logs of a full run at 80 requests a minute through the runner's two lanes, from first request to last exit, with the shared pacer. A run adds the compile of the private build copy, 11 to 16 seconds in the measured runs

| Category            | Checks                                                                                          |  Time | Requests |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----: | -------: |
| `smoke`             | `rate-limits`, `messages`, `event-waits`, `instance`, `recovery`                                | 2m02s |      104 |
| `messages`          | `messages`, `nonce`, `management`, `batch-delete`, `events`, `typing`                           | 2m54s |      232 |
| `message-content`   | `message-fields`, `embeds`, `optional-tools`, `search`                                          | 2m22s |      190 |
| `consumer-features` | `consumer-features`                                                                             | 0m50s |       64 |
| `history`           | `history`, `pagination`, `pins`                                                                 | 2m40s |      212 |
| `cleanup`           | `cleanup@default`                                                                               | 1m40s |      133 |
| `cleanup-effect`    | `cleanup@effect`                                                                                | 1m40s |      133 |
| `own-history`       | `own-history`, `text-validation`                                                                | 1m39s |      130 |
| `reactions`         | `reactions@default`                                                                             | 1m55s |      146 |
| `reactions-effect`  | `reactions@effect`                                                                              | 1m54s |      146 |
| `channels`          | `channels`, `gateway-capture`, `guild-events`, `voice`                                          | 2m43s |      216 |
| `threads`           | `threads`, `voice-notes`                                                                        | 2m57s |      232 |
| `roles`             | `guilds`, `administration`, `message-members`                                                   | 2m48s |      222 |
| `server-settings`   | `consumer-operations`, `guild-features`                                                         | 2m25s |      160 |
| `members`           | `member-search`, `member-chunks`, `guild-lifecycle`                                             | 1m37s |       98 |
| `webhooks`          | `webhooks`, `announcements`                                                                     | 2m16s |      182 |
| `uploads`           | `attachments`, `attachment-sources`                                                             | 2m22s |      188 |
| `cache-collectors`  | `cache`, `collectors`                                                                           | 2m27s |      194 |
| `commands`          | `command-arguments`, `command-help`, `command-groups`, `event-waits`                            | 1m31s |      122 |
| `connection`        | `sandbox`, `sdk`, `application`, `diagnostics`, `bot-runner`, `recovery-window-session-restart` | 1m33s |       66 |
| `recovery`          | `recovery`, `recovery:cancel`                                                                   | 1m44s |       28 |
| `recovery-window`   | `recovery-window@default`, `recovery-window@effect`                                             | 2m52s |       16 |
| `sharding`          | `sharding`, `supervisor`                                                                        | 0m26s |       28 |
| `oauth`             | `oauth:no-consent`, `application`                                                               | 0m22s |       30 |
| `rate-limits`       | `rate-limits`                                                                                   | 0m18s |       22 |
| `expressions`       | `expressions`                                                                                   | 1m32s |      118 |
| `discovery-invites` | `discovery`, `invites`, `vanity`                                                                | 1m17s |      102 |
| `typed-raw`         | `typed-raw`                                                                                     | 0m17s |       22 |

### Release runs

Before a release, and only then, run the whole suite with `pnpm --filter @neontechspace/fluxerly test:live:all -- --full`.
It runs only the categories that have not already passed on the same code, and prints for each category whether it runs and why, or which earlier pass it reuses.
Every run that passes all of a category's checks records that pass in the ignored `.env.test.passes.json` in the SDK folder, with a hash of the category's inputs: All SDK source and compiler settings, because `--changed` picks likely categories rather than every category whose checks run a file, its harness files, the live support code and runner, the SDK package manifest, the lockfile and the [Fluxer pin](/projects/release/upstream/manifest.json). Documentation and website files are never inputs.
A pass counts only while that hash matches the current files, committed or not, and for at most 14 days, so changes on Fluxer's side are still caught. A failed, timed-out, recovered-only or skipped run of a category removes its pass, and a throttled run removes the pass of every category it touched. Outside a Git checkout nothing is reused or recorded.
Add `--fresh` to run every category regardless of earlier passes. A release run that reuses nothing sends about 3,300 requests at 80 a minute, so it takes about 42 minutes, and two lanes keep the checks that wait from adding much to that.
Only the `recover` scenario waits for a heartbeat acknowledgement after its forced resume, since the SDK sends the first heartbeat about 41 seconds after each Hello. The other resume scenarios prove the resume itself

### Pace calibration

The 750 ms pace is measured safe: Runs of several thousand requests at that pace met no hosted 429.
A faster pace needs a measurement, never a guess or a probe. `node tests/live/calibrate-pace.js` measures one, only with process-only `FLUXERLY_LIVE_CALIBRATE=1` and only when a maintainer decides to.
It holds the exclusive sandbox lock and sends only read-only requests, rotating over five reads the checks already make. It starts at 80 a minute and adds 10 a minute every two minutes, up to 160 a minute or process-only `FLUXERLY_LIVE_CALIBRATE_CEILING`, about 2,200 requests over 18 minutes when nothing refuses one.
It stops at the first 429, front door or route, and that 429 pauses every sender and marks the run throttled as above. It stores 80% of the highest rate that finished without one in the ignored `.env.test.pace-calibration.json`.
A run uses that pace only with `--calibrated-pace`, and the stored result counts for 14 days. Wait at least the `Retry-After` after a calibration that met a 429

## Package scripts

| Script                                                                    | Purpose                                                                                                                                                                                                                      | Outside effects                                                                                                                                                                                          | Authorization  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `test:live`                                                               | Hosted protocol discovery, readiness and heartbeats                                                                                                                                                                          | No server-content changes                                                                                                                                                                                | SDK work       |
| `test:live:all`                                                           | Named [categories](/projects/sdk/tests/live/README.md#categories) or checks, `--changed` or `--full`                                                                                                                         | Those of the checks it runs                                                                                                                                                                              | SDK work       |
| `test:live:sdk`                                                           | Built default/native client connection, the READY self lookup, a raw bot-self REST read and shutdown                                                                                                                         | No server-content changes                                                                                                                                                                                | SDK work       |
| `test:live:application`                                                   | Current-bot application and installation links                                                                                                                                                                               | Read-only. Requests the installation link once without following its redirect. No navigation, authorization, or server-content changes                                                                   | SDK work       |
| `test:live:oauth:default`, `test:live:oauth:effect`                       | Manual authorization-code exchange, bearer reads, introspection, refresh and revocation                                                                                                                                      | Interactive identity, guild-list and connections consent, temporary tokens and an owned localhost callback listener. No bot installation or permission changes                                           | Person present |
| `test:live:oauth:no-consent`                                              | OAuth URL construction and rejection without consent                                                                                                                                                                         | Shared sandbox lock and read-only application, bot, guild, OAuth and connection checks. No browser navigation, consent, callback listener, token issuance, refresh or revocation                         | SDK work       |
| `test:live:instance`                                                      | Instance discovery and bot-self read                                                                                                                                                                                         | Read-only unauthenticated bootstrap and bot-self REST requests. No server-content changes                                                                                                                | SDK work       |
| `test:live:diagnostics`                                                   | Diagnostics and cache clearing                                                                                                                                                                                               | Read-only with the shared sandbox lock, no gateway connection or remote mutation                                                                                                                         | SDK work       |
| `test:live:rate-limits`                                                   | Global and learned-bucket waiting and recovery, including raw REST requests                                                                                                                                                  | One synthetic 429 and three scheduling-header overrides per API, with read-only bot-self and guild requests. No deliberate hosted throttling or remote mutation                                          | SDK work       |
| `test:live:consumer-operations`                                           | Banner URLs, attachment deletion, bot roles and counts                                                                                                                                                                       | Temporary channel/messages and one zero-permission role assigned only to the test bot, plus test-owned response loss and socket interruption                                                             | SDK work       |
| `test:live:member-chunks`                                                 | Member selection and streamed failure/recovery                                                                                                                                                                               | Read-only guild/member requests, test-owned reply drops and one socket interruption per mode, no server-content changes                                                                                  | SDK work       |
| `test:live:sharding`                                                      | Two-shard routing, owning-shard counts, recovery and cancellation                                                                                                                                                            | Read-only sandbox requests, one test-owned shard-socket interruption and one cancelled startup per mode, no content or account-presence changes                                                          | SDK work       |
| `test:live:supervisor`                                                    | Child assignments, connections and shutdown                                                                                                                                                                                  | Read-only sandbox API and gateway requests plus an owned loopback proof endpoint. No content or account-state changes                                                                                    | SDK work       |
| `test:live:presence`                                                      | Interactive presence and reconnect restoration                                                                                                                                                                               | No account-state changes by the harness. The authorized participant performs visible status transitions and the harness interrupts only its own socket                                                   | Person present |
| `test:live:messages`                                                      | SDK receive/reply, and a text-to-speech send whose response value is checked                                                                                                                                                 | Temporary channel and messages, including one text-to-speech message in that channel                                                                                                                     | SDK work       |
| `test:live:nonce`                                                         | Nonce defaults, suppression and reconciliation                                                                                                                                                                               | Journaled temporary channel/messages and one test-owned response loss per API. Cleanup verifies channel deletion                                                                                         | SDK work       |
| `test:live:optional-tools`                                                | Builders and prefix-command lifecycle                                                                                                                                                                                        | Temporary channel and test-bot command/reply messages. No human or member actions                                                                                                                        | SDK work       |
| `test:live:event-waits`                                                   | Filtered event waits and failure cleanup                                                                                                                                                                                     | One journaled temporary channel and bot messages, with raw readback and verified channel removal                                                                                                         | SDK work       |
| `test:live:command-arguments`                                             | Typed commands and invalid-input recovery                                                                                                                                                                                    | One journaled temporary channel and bot messages, with raw reply readback and verified channel removal                                                                                                   | SDK work       |
| `test:live:command-help`                                                  | Help pagination and delivery                                                                                                                                                                                                 | One journaled temporary channel and bot messages, with raw page readback and verified channel removal                                                                                                    | SDK work       |
| `test:live:command-groups`                                                | Nested commands and scoped help                                                                                                                                                                                              | One journaled temporary channel and bot messages/replies, with raw readback and verified channel removal                                                                                                 | SDK work       |
| `test:live:message-fields`                                                | Message projections                                                                                                                                                                                                          | One journaled temporary channel, bot messages and a small attachment, with reply/edit/pin operations, raw readback and verified channel removal                                                          | SDK work       |
| `test:live:consumer-features`                                             | Forwarding, embeds, file metadata, flags and profiles                                                                                                                                                                        | Journaled temporary channel/messages and uploads, test-owned response loss. Profile reads target only the designated bot and may trigger provider expired-premium cleanup                                | SDK work       |
| `test:live:typing`                                                        | One-shot typing, scoped refresh and completion/cancellation cleanup through both APIs                                                                                                                                        | Temporary channel/messages and ephemeral typing notices. Does not prove inbound typing delivery                                                                                                          | SDK work       |
| `test:live:typing:interactive`                                            | Human-visible outgoing typing and selected-member inbound events through both APIs                                                                                                                                           | Temporary channel and typing notices, with awaited refresh shutdown and verified channel removal                                                                                                         | Person present |
| `test:live:roles:reset`                                                   | Guild-wide role-display reset and lost-response reconciliation through both APIs                                                                                                                                             | Two temporary zero-permission roles and whole-guild display reset, with existing display assignments required to be null                                                                                 | Per run        |
| `test:live:recovery`                                                      | Forced socket loss, resume, diagnostics and subsequent receive/reply                                                                                                                                                         | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:recovery:cancel`                                               | Managed cancellation during recovery and socket cleanup                                                                                                                                                                      | Test-socket termination, no server-content changes                                                                                                                                                       | SDK work       |
| `test:live:management`                                                    | Remote fetch, edit and deletion                                                                                                                                                                                              | Temporary channel/messages and test-message edits/deletions                                                                                                                                              | SDK work       |
| `test:live:batch-delete`                                                  | Explicit message batches, events/cache, missing IDs and lost-response reconciliation                                                                                                                                         | Temporary channel/messages and test-owned response loss                                                                                                                                                  | SDK work       |
| `test:live:moderation:default`, `test:live:moderation:effect`             | Timeout/clear, kick, ban expiry/unban, events and lost-response reconciliation                                                                                                                                               | Authorized disposable member moderation, temporary channel/messages, test-owned response loss                                                                                                            | Person present |
| `test:live:webhooks`                                                      | Webhook management, delivery and credential revocation                                                                                                                                                                       | Temporary webhooks, channels/messages, file uploads and test-owned response loss                                                                                                                         | SDK work       |
| `test:live:announcements`                                                 | Announcement following, publishing, conversion and recovery                                                                                                                                                                  | Journaled temporary channels, follower webhooks and messages, with test-owned response loss and verified removal                                                                                         | SDK work       |
| `test:live:expressions`                                                   | Emoji/sticker lifecycle, source-guild reads, gateway updates, partial batches and sticker messages                                                                                                                           | Journaled temporary expressions and a channel, with verified test-owned removal and no media purging                                                                                                     | SDK work       |
| `test:live:invites`                                                       | Invite lifecycle and recovery                                                                                                                                                                                                | Temporary channel and invites. No invite acceptance or membership changes                                                                                                                                | SDK work       |
| `test:live:administration`                                                | Server settings and filtered audit logs                                                                                                                                                                                      | Temporary sandbox server renaming, restoration, audit records and test-owned response loss                                                                                                               | SDK work       |
| `test:live:guild-features`                                                | Clone opt-ins and feature restoration                                                                                                                                                                                        | Temporary sandbox cloning permissions and owner-crown visibility, audit records and verified restoration                                                                                                 | SDK work       |
| `test:live:vanity`                                                        | Custom-invite reads, read recovery and disabled-feature rejection through both APIs                                                                                                                                          | No intended successful mutation, uses a reserved code for rejection checks                                                                                                                               | SDK work       |
| `test:live:vanity:mutate:default`, `test:live:vanity:mutate:effect`       | Manual custom-invite lifecycle and lost-response reconciliation                                                                                                                                                              | Temporary custom codes on an eligible sandbox with no existing code                                                                                                                                      | Per run        |
| `test:live:discovery`                                                     | Directory search, categories, eligibility/status and read recovery through both APIs                                                                                                                                         | Read-only, never submits an application                                                                                                                                                                  | SDK work       |
| `test:live:member-search`                                                 | Indexed member search and permissions                                                                                                                                                                                        | Resource reads and search requests, which can trigger provider lazy indexing. No member moderation or role/channel edits                                                                                 | SDK work       |
| `test:live:message-members`                                               | A message dispatch refills the author's removed cached member without a member request                                                                                                                                       | Journaled temporary channel and bot message, with verified removal. Drops only the bot's cached member. Holds the exclusive lock, since other checks' bot reactions or typing could refill it            | SDK work       |
| `test:live:gateway-capture`                                               | Captures the temporary channel's gateway dispatches and checks their scrubbing, without replacing the fixture                                                                                                                | One journaled temporary channel with bot messages, one reaction, one typing notice and a topic edit, with verified channel removal                                                                       | SDK work       |
| `test:live:members`                                                       | Authorized target-member nickname set, independent readback and restoration through both APIs                                                                                                                                | Temporary nickname change for one currently authorized non-owner member                                                                                                                                  | Per run        |
| `test:live:guild-lifecycle`                                               | Bot membership pages and bounded traversal through both APIs                                                                                                                                                                 | Read-only. Leaving requires the separate direct command                                                                                                                                                  | SDK work       |
| `test:live:discovery:mutate:default`, `test:live:discovery:mutate:effect` | Manual directory application lifecycle and lost-response reconciliation                                                                                                                                                      | Real review-queue submission or immediate public listing, then test-owned withdrawal                                                                                                                     | Per run        |
| `test:live:users:default`, `test:live:users:effect`                       | Public user reads, private conversations, bot server-profile edits and message failure reconciliation                                                                                                                        | Test DMs, authorized group messages/renaming, bot profile changes and test-owned response loss                                                                                                           | Per run        |
| `test:live:events`                                                        | Gateway delivery after raw API mutations                                                                                                                                                                                     | Temporary channel/messages and test-message edits/deletions                                                                                                                                              | SDK work       |
| `test:live:reactions`                                                     | Reactions, collectors and recovery                                                                                                                                                                                           | Temporary channel/messages, reactions and guild emoji, plus test-socket termination                                                                                                                      | SDK work       |
| `test:live:pins`                                                          | Pin/unpin, explicit pages, pin status/events and recovery                                                                                                                                                                    | Temporary channel/messages and pins, server-created pin notices, plus test-socket termination                                                                                                            | SDK work       |
| `test:live:guilds`                                                        | Guild/member reads, role lifecycle, caches, cache-first permissions and recovery                                                                                                                                             | Temporary channel/messages, two zero-permission test roles with assignment only to the designated bot, plus test-socket termination and test-owned response loss                                         | SDK work       |
| `test:live:guild-events`                                                  | Guild create delivery after READY, with the cached self member and role list                                                                                                                                                 | Read-only gateway connection to the existing sandbox guild. Fails when it is unavailable or the bounded event wait expires                                                                               | SDK work       |
| `test:live:voice`                                                         | Initial voice snapshots and member mute/deaf flags through both built APIs                                                                                                                                                   | Read-only sandbox gateway/member observations. No participant moderation, joining or media                                                                                                               | SDK work       |
| `test:live:voice-controls:default`, `test:live:voice-controls:effect`     | Manual selected-participant move/disconnect and mute/deafen controls, with snapshots, events and REST readback                                                                                                               | Temporary voice channel and participant state changes, followed by participant rejoin, baseline restoration and verified channel removal                                                                 | Person present |
| `test:live:channels`                                                      | Channel lifecycle, overwrites, audit logs, cache retention and recovery                                                                                                                                                      | Temporary channels/categories, overwrites targeting only the bot and test guild's everyone role, test-socket termination and test-owned response loss                                                    | SDK work       |
| `test:live:threads`                                                       | Threads, forum channels and webhook thread posts, with thread events and parent-deletion cache eviction                                                                                                                      | Three journaled temporary channels including a forum, their threads and posts, and one forum webhook, with verified removal of the webhook, channels and threads                                         | SDK work       |
| `test:live:voice-notes`                                                   | Voice notes in a channel, a forum post and a webhook, with voiceWaveform and Fluxer readback                                                                                                                                 | Two journaled temporary channels including a forum, three synthetic WAV voice notes, a forum post and a webhook, with verified removal                                                                   | SDK work       |
| `test:live:typed-raw`                                                     | `client.rest.call` on a read with path parameters and a query, a message send, `GET /gateway/bot`, a send with a file and an edit that keeps it beside a new file, and the sent message as a documented raw `MESSAGE_CREATE` | One journaled temporary channel and one bot message in it, with verified channel removal                                                                                                                 | SDK work       |
| `test:live:history`                                                       | Explicit history pages checked against API readback                                                                                                                                                                          | Temporary channel and messages                                                                                                                                                                           | SDK work       |
| `test:live:cleanup`                                                       | Guild summaries, hierarchy and bounded message cleanup                                                                                                                                                                       | Temporary channel and test-bot messages, with one lost batch response. Uses the existing channel recovery journal and verifies test-owned cleanup                                                        | SDK work       |
| `test:live:own-history`                                                   | Channel and thread own-history deletion, thread-only scope and lost-response/cancellation reconciliation                                                                                                                     | Two journaled temporary channels, an active and an archived thread and bot messages, with verified removal. Guild-wide deletion requires the separate direct command                                     | SDK work       |
| `test:live:search`                                                        | Bounded contextual indexed-message search, explicit indexing and cache exclusion                                                                                                                                             | Temporary channel/messages. May report a hosted indexing timeout                                                                                                                                         | SDK work       |
| `test:live:pagination`                                                    | History/member/reactor/pin traversal and cleanup                                                                                                                                                                             | Temporary channel/messages, reactions and pins, plus test-owned transient read failure and delayed response delivery                                                                                     | SDK work       |
| `test:live:cache`                                                         | Cache intake, expiry and recovery invalidation                                                                                                                                                                               | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:collectors`                                                    | Collector completion, gap failure and use after recovery                                                                                                                                                                     | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:embeds`                                                        | Embed send/reply/edit, readback, events, cache and collectors                                                                                                                                                                | Temporary channel/messages and test-message edits                                                                                                                                                        | SDK work       |
| `test:live:attachments`                                                   | Uploads, binary readback, file edits, events/cache/collectors and recovery                                                                                                                                                   | Temporary channel/messages, 50 MiB file upload/download, file replacements and test-socket termination                                                                                                   | SDK work       |
| `test:live:attachment-sources`                                            | File/stream uploads, URL refresh and bounded download recovery                                                                                                                                                               | Temporary channel/messages, one test-owned temporary file and delayed-EOF wrapper. The injected 403 targets only the current channel's unique attachment plan and does not change provider configuration | SDK work       |

## Direct harness commands

Run each command with `default` and then `effect` unless stated otherwise

| Command                                                        | Purpose and outside effects                                                                                                                                                                                                                                               | Authorization  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `node tests/live/bot-runner.js default`                        | Public bot runner against the sandbox. Checks synchronous misuse rejection, interrupts only its own gateway connection, cancels during recovery and fails a test-owned setup callback, then verifies client, socket and signal-listener cleanup. Read-only                | SDK work       |
| `node tests/live/text-validation.js default`                   | Local rejection, normalized UTF-16 boundary writes and reconciliation of an intentionally lost edit response without replay. One journaled zero-permission role per mode, with no human membership or existing role changed                                               | SDK work       |
| `node tests/live/recovery-window.js default`                   | Gateway recovery window of at least 165 seconds per mode, interrupting only its own authenticated sockets, including one locally delayed Hello frame. No server mutations                                                                                                 | SDK work       |
| `node tests/live/recovery-window.js default --session-restart` | SessionStore shutdown followed by a new client that must receive RESUMED rather than READY within the retention window. Uses only its own sockets and in-memory store, with verified sandbox identity and no server mutations                                             | SDK work       |
| `node tests/live/sdk.js default --quality`                     | Local validation rejection and user/private-channel cache reads for an authorized member and group. No messages or remote state changes                                                                                                                                   | Per run        |
| `node tests/live/users.js default --latest-only`               | Latest-private-message batch failure/recovery with marker-owned test DMs. No profile, presence or group changes                                                                                                                                                           | Per run        |
| `node tests/live/messages.js default --attachments-small`      | The `test:live:attachments` checks with a 1 MiB file instead of 50 MiB, a quicker way to troubleshoot them. Same outside effects otherwise                                                                                                                                | SDK work       |
| `node tests/live/calibrate-pace.js`                            | Measures a faster request pace with read-only requests and stores it, as [pace calibration](/projects/sdk/tests/live/README.md#pace-calibration) describes. Spends the address's request budget for up to 18 minutes and may meet a hosted 429. Runs once, without a mode | Per run        |
| `node tests/live/gateway-capture.js --write`                   | Replaces the [gateway capture fixture](/projects/sdk/tests/contract/fixtures/gateway-captures.json) with a fresh scrubbed capture. Runs once, without a mode. Same outside effects as `test:live:gateway-capture`                                                         | SDK work       |
| `node tests/live/own-history.js default --guild`               | Irreversible deletion of every message the designated bot authored in the sandbox server                                                                                                                                                                                  | Per run        |
| `node tests/live/guild-lifecycle.js default --leave`           | The bot leaves the server, with membership-list verification. Add `--lose-response` to discard the successful response and verify reconciliation without replay                                                                                                           | Person present |
| `node tests/live/voice-controls.js default --flags-only`       | Mute/deafen checks without moving or disconnecting the participant. Use `--no-move` instead to include disconnect and rejoin without creating a channel                                                                                                                   | Person present |

## Check requirements

### Gateway captures

The [gateway capture test](/projects/sdk/tests/contract/gateway-captures.test.ts) replays scrubbed dispatches recorded from the hosted service and fails on a payload field the SDK neither exposes nor caches, unless its explicit ignore list names the field with a reason.
Fields for which every replacement is rejected, such as empty lists and an ID that must match the actor, cannot be judged and sit in a separate reasoned list, so an unread field there goes unreported.
Refresh the fixture after Fluxer changes a payload, or to cover another dispatch.
Build the SDK, run `node tests/live/gateway-capture.js --write` from `projects/sdk/`, review the fixture diff and run `pnpm exec vitest run tests/contract/gateway-captures.test.ts --maxWorkers=1`.
A new unread field needs either an SDK change or a reasoned ignore entry.
Add a dispatch by extending `triggerAndCollect` in the harness

The harness writes its journal on every run, with or without `--write`, and writes the fixture only with it.
It keeps only the bot's own dispatches in its temporary channel, and drops other members' messages, reactions and typing.
Its [scrubber](/projects/sdk/tests/live/support/gateway-scrub.js) replaces every string with a stable placeholder, passes numbers only under reviewed protocol field names, and refuses unreviewed field names and large numbers outside time fields.
It refuses to continue when the result still holds the token, the server, bot or channel IDs, or an account or server name.
It also refuses a captured string that survives: Strings of 8 or more characters anywhere inside other text, strings of 4 to 7 characters as a whole value only, and strings under 4 characters not at all.
Digit-only strings under 8 digits are not checked either.
A capture with a new field name stops until the name is reviewed and added to the scrubber.
Raw payloads are never printed or stored

### Presence and interactive typing

Presence checks require process-only `FLUXER_TEST_PRESENCE_USER_ID`, an authorized non-bot sandbox guild member.
After a selected guild presence baseline, the harness reports bounded stages for that participant's visible DND and online transitions, including one test-owned socket interruption and resumed-session observation.
The participant makes the status changes, and the harness sends an unacknowledged empty selection during cleanup.
For the final invocation, process-only `FLUXER_TEST_PRESENCE_RESTORE_STATUS` can request a verified return to the participant's original `online`, `idle`, `dnd` or `offline` status. Here, `offline` means selecting Invisible while connected

Interactive typing requires process-only `FLUXER_TEST_TYPING_USER_ID` for an authorized non-bot sandbox member.
The participant opens the reported temporary channel, observes the bot indicator and types without sending a message.
Enter `visible default` or `visible effect` in the running terminal only after observing that mode's indicator, or `stop` to end the check.
An authorized browser operator can enter `browser default` or `browser effect` after checking the rendered indicator, which records browser observation separately from human confirmation.
Each mode waits up to three minutes for both that confirmation and the selected member's SDK typing event

### Role display reset

Role display reset requires process-only `FLUXER_TEST_ROLE_RESET_GUILD_ID` matching the configured sandbox, and permission to reset guild-wide role display positions.
The harness refuses existing non-null display assignments, then uses two journaled zero-permission roles for successful and lost-response resets through both APIs.
No member assignments are changed

### OAuth consent

OAuth checks require `FLUXER_TEST_CLIENT_SECRET` and `FLUXER_TEST_OAUTH_REDIRECT_URI=http://localhost:3000/auth/fluxer/callback` in the ignored SDK env file.
Register that exact redirect on the sandbox bot's application and leave localhost port 3000 free

Run one OAuth mode at a time, with fresh consent and the account owner's current permission for identity, guild-list and connections reads.
The URL requests only `identify guilds connections`. It omits `bot` because Fluxer rejects adding the existing sandbox bot again.
Keep the bot's membership and permissions unchanged. The no-consent check covers installation URL construction separately

Open the printed authorization URL and approve within five minutes, without sharing the callback URL or code.
The harness keeps issued tokens only in memory and revokes known tokens before closing its callback listener and SDK lifetime

If the process crashes or reports uncertain issuance or unconfirmed revocation, the consenting user must revoke this sandbox application's authorization in Fluxer settings.
Open personal settings, then Account → Security → Account access → Authorized apps → Manage, and revoke only the sandbox app.
Tokens cannot be recovered from a journal, and successful token revocation does not remove the provider's saved consent record

### Whole-history deletion

Whole-own-history guild checks require current authorization to erase all messages authored by the designated bot in the sandbox server.
This deletion is irreversible and cannot be limited to messages created by the test.
Supply process-only `FLUXER_TEST_DELETE_MINE_GUILD_ID` matching the configured sandbox, never another server

The harness verifies identity and membership and journals its test-owned channels and its two threads, one of them archived before the deletion.
An existing journal triggers recovery only, without repeating whole-history deletion.
Cleanup removes only the journaled threads and channels, checks that no journaled thread remains active or archived, and cannot restore deleted history.
Other-author readback covers only a reported sample, not a complete inventory

### Voice controls

Voice-control checks require process-only `FLUXER_TEST_VOICE_USER_ID` for a currently consenting sandbox member connected to one voice session.
The bot needs ManageChannels, Connect, MoveMembers, MuteMembers and DeafenMembers, plus a successful hierarchy check for that participant

Run each mode separately. Keep the participant available to rejoin the original channel within 90 seconds after disconnection.
The harness cannot make a disconnected participant join, and the bot never joins or handles media.
Recovery uses fresh gateway and REST observations and refuses unexpected state

### Custom invites and public discovery

Custom-invite mutation checks need a specifically authorized disposable server with `VANITY_URL`, ManageGuild permission and no existing custom code.
Supply two distinct, available lowercase codes through `FLUXER_TEST_VANITY_CODE` and `FLUXER_TEST_VANITY_SECOND_CODE`, plus `FLUXER_TEST_VANITY_MUTATIONS=1`.
Run each mutation mode separately. Successful invite inspection also needs a channel visible to everyone

Changing an existing code cannot guarantee reclaiming it, so the harness refuses that scenario.
Read and rejection checks do not establish successful setting, replacement, removal or lost-response recovery

Discovery mutation checks require specific permission for real directory submission and possible immediate public listing.
Use an eligible disposable sandbox with no existing application or listing, and set `FLUXER_TEST_DISCOVERY_MUTATIONS=1` for that invocation.
Optionally select `FLUXER_TEST_DISCOVERY_CATEGORY_ID`. The default is the provider's Other category.
Run the default and Effect mutation scripts separately.
Partial provider writes can require manual reconciliation. Search-index removal and reviewer notifications are not reversible.
Read-only script success is not live application-lifecycle proof

### Private conversations

User and private-conversation checks require current authorization for the recipient supplied through `FLUXER_TEST_DM_USER_ID`.
The harness verifies the recipient's membership in the designated sandbox, preserves pre-existing open DMs and removes test-owned messages

Existing-group checks also require current permission to rename and send messages in the channel supplied through `FLUXER_TEST_GROUP_DM_ID`.
Use a named temporary group owned by the authorized recipient, containing only that account and the sandbox bot.
An explicitly authorized additional account can be supplied through `FLUXER_TEST_GROUP_EXTRA_USER_ID`.
The harness preserves membership, restores the original group name and deletes only test-owned messages.
Without a selected group, or with `--without-group`, the script reports group checks as skipped. That run is not group verification

The `--latest-only` mode uses the same recipient without group or profile changes, and restores whether the bot had the conversation open.
The `--quality` mode of `sdk.js` reads the recipient and an existing group owned by that member, without sending messages

### Member changes, moderation and leaving a guild

Nickname checks require the currently authorized non-bot, non-owner target in process-only `FLUXER_TEST_MEMBER_ID`.
The harness rereads the nickname immediately before writing, deliberately loses one response after the marker write and verifies that the SDK reports an unknown outcome and evicts its member cache.
It then reconciles raw state before restoration

Each moderation invocation requires current authorization for its disposable account and a person available to handle rejoining.
Supply the account ID through process-only `FLUXER_TEST_MODERATION_USER_ID`. A missing or invalid ID fails before live requests.
The account must be a current non-owner, non-administrator member without an existing timeout or ban.
Run each moderation mode separately and re-add the account between runs.
The checks never delete its messages and leave it unbanned, but cannot restore its membership or previous roles

Before each leave invocation, coordinate with the person who can re-add the bot, and supply the currently authorized `FLUXER_TEST_LEAVE_GUILD_ID` in the process environment.
It must name the sandbox server, and any other ID fails before live requests.
The harness preserves authored messages and checks independent membership-list removal, but cannot re-add the bot or prove continued access to its former messages.
It creates no remote resources and no journal. If interrupted after dispatch, inspect bot membership and re-add the bot before further checks in that server

## Coverage limits

Member-chunk checks require a sandbox with fewer than 1,000 members and compare the response with one fresh REST member page.
The harness can wait once for a confirmed full-list rate limit left by a prior mode, then make a new request.
It reports whether the hosted gateway actually rejects an immediate repeat. Acceptance does not verify live rate-limit handling.
Multi-batch arrival, missing-batch and slow-reader behavior use local transport tests rather than a large live guild

## Journals and restoration

Each journal is an ignored `.env.test.<name>.local` file in `projects/sdk/` and never records credentials.
The header comment of the owning harness states what its journal records and how an existing journal is recovered.
Most journal names match their harness file. The exceptions are `guild-features` (`guild-feature-toggles.js`), `typing` (`typing-interactive.js`), `role-reset` (`role-display-reset.js`) and `vanity` (`vanity-url.js`).
Scenarios of `messages.js` and `command-conveniences.js` keep separate journals, such as `messages-reactions` and `command-conveniences-waits`, so rerunning the failed script finds its own journal

## Harness rules

These rules apply when writing or changing a harness. [Harness source](/projects/sdk/tests/live/) owns detailed assertions and bounded execution

- Verify bot, application and server identity, and take the sandbox lock, before live requests. A harness that needs only the bot ID may use `sandboxBotId`, which accepts the runner's verification of the same env file
- Declare every new harness or scenario in [check classes](/projects/sdk/tests/live/support/check-classes.js). Choose `shared-state` when unsure
- Use the [shared harness support](/projects/sdk/tests/live/support/) for the lock, env loading, process-only values, journals, identity checks, owned finalization, JSON-lines reports, result unwrapping and direct sandbox requests instead of copying them
- Describe a new journal in the harness header comment: What it records and how recovery restores or removes it
- Let the process environment supply or override target IDs for other people's accounts, whole-guild effects and irreversible actions. Never hardcode a real account ID or treat a stored value as authorization
- Record test-owned markers before dispatch and returned IDs when available. Verify restoration or removal before deleting the journal
- Journal writes and remote operations are not atomic. Reconcile lost responses through recorded identity rather than blindly retrying writes
- Fail closed on corrupt, conflicting or unresolved state, and keep the journal for inspection
- When a journal exists, perform recovery only. A fresh test requires a separate invocation after verified cleanup
- Never store credentials, tokens, invite or custom codes, or message bodies in journals or output
- Reread state immediately before a restoring write. Fluxer's PATCH has no conditional precondition, so conflict checks cannot make the read-and-write sequence atomic
- Always include a user or action filter in audit queries. Fluxer may rewrite deletion records during an unfiltered read
