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
Rerun the same script. That run only cleans up.
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

`pnpm --filter @neontechspace/fluxerly test:live:all` builds the SDK once and runs every SDK-work check below, including the SDK-work direct harness commands.
It runs the shared-state checks one at a time first, then the others, one at a time unless `--concurrency` allows more.
Name checks to run only those, for example `test:live:all pins webhooks`. Package scripts are named without their `test:live:` prefix, `test:live` is `sandbox`, and direct commands are named after their harness file, such as `bot-runner`.
The runner refuses Per run and Person present checks, and passes no `FLUXER_TEST_` process values, so checks read only the env file

| Option                  | Effect                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--concurrency <n>`     | Maximum shared-lock checks at once, 1 by default                                                                                                                               |
| `--timeout-minutes <n>` | Stops a harness process after this time, 25 minutes by default. Its lock file stays behind as a stale lock, so the runner starts no further checks and records them as skipped |
| `--out <directory>`     | Log directory. By default a new `fluxerly-live-<time>` directory in the system temp folder                                                                                     |
| `--list`                | Prints every check with its lock class and whether it is SDK work                                                                                                              |

Each check writes `<check>.log` and the run writes `summary.txt` with results, durations and any remaining lock files or journals.
The exit code is nonzero when a check fails or is skipped, or a lock file or journal remains.
Every check shares one request budget. Beyond the per-route limits, Fluxer's edge answers any route with a plain-text 429 and `Retry-After: 5` once a per-minute request count is spent, and keeps refusing for up to a minute.
Runs with a concurrency of 2 and 4 reached that limit within minutes and then failed many checks, so a higher concurrency suits only checks that mostly wait, such as `recovery-window`.
When a check fails only when run together with others, declare it `shared-state` instead of weakening its assertions

## Package scripts

| Script                                                                    | Purpose                                                                                                        | Outside effects                                                                                                                                                                                          | Authorization  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `test:live`                                                               | Hosted protocol discovery, readiness and heartbeats                                                            | No server-content changes                                                                                                                                                                                | SDK work       |
| `test:live:all`                                                           | Every SDK-work check, [run together](/projects/sdk/tests/live/README.md#running-checks-together)               | Those of the checks it runs                                                                                                                                                                              | SDK work       |
| `test:live:sdk`                                                           | Built default/native client connection, a raw bot-self REST read and shutdown                                  | No server-content changes                                                                                                                                                                                | SDK work       |
| `test:live:application`                                                   | Current-bot application and installation links                                                                 | Read-only. Requests the installation link once without following its redirect. No navigation, authorization, or server-content changes                                                                   | SDK work       |
| `test:live:oauth:default`, `test:live:oauth:effect`                       | Manual authorization-code exchange, bearer reads, introspection, refresh and revocation                        | Interactive identity, guild-list and connections consent, temporary tokens and an owned localhost callback listener. No bot installation or permission changes                                           | Person present |
| `test:live:oauth:no-consent`                                              | OAuth URL construction and rejection without consent                                                           | Shared sandbox lock and read-only application, bot, guild, OAuth and connection checks. No browser navigation, consent, callback listener, token issuance, refresh or revocation                         | SDK work       |
| `test:live:instance`                                                      | Instance discovery and bot-self read                                                                           | Read-only unauthenticated bootstrap and bot-self REST requests. No server-content changes                                                                                                                | SDK work       |
| `test:live:diagnostics`                                                   | Diagnostics and cache clearing                                                                                 | Read-only with the shared sandbox lock, no gateway connection or remote mutation                                                                                                                         | SDK work       |
| `test:live:rate-limits`                                                   | Global and learned-bucket waiting and recovery, including raw REST requests                                    | One synthetic 429 and three scheduling-header overrides per API, with read-only bot-self and guild requests. No deliberate hosted throttling or remote mutation                                          | SDK work       |
| `test:live:consumer-operations`                                           | Banner URLs, attachment deletion, bot roles and counts                                                         | Temporary channel/messages and one zero-permission role assigned only to the test bot, plus test-owned response loss and socket interruption                                                             | SDK work       |
| `test:live:member-chunks`                                                 | Member selection and streamed failure/recovery                                                                 | Read-only guild/member requests, test-owned reply drops and one socket interruption per mode, no server-content changes                                                                                  | SDK work       |
| `test:live:sharding`                                                      | Two-shard routing, owning-shard counts, recovery and cancellation                                              | Read-only sandbox requests, one test-owned shard-socket interruption and one cancelled startup per mode, no content or account-presence changes                                                          | SDK work       |
| `test:live:supervisor`                                                    | Child assignments, connections and shutdown                                                                    | Read-only sandbox API and gateway requests plus an owned loopback proof endpoint. No content or account-state changes                                                                                    | SDK work       |
| `test:live:presence`                                                      | Interactive presence and reconnect restoration                                                                 | No account-state changes by the harness. The authorized participant performs visible status transitions and the harness interrupts only its own socket                                                   | Person present |
| `test:live:messages`                                                      | SDK receive/reply, and a text-to-speech send whose response value is checked                                   | Temporary channel and messages, including one text-to-speech message in that channel                                                                                                                     | SDK work       |
| `test:live:nonce`                                                         | Nonce defaults, suppression and reconciliation                                                                 | Journaled temporary channel/messages and one test-owned response loss per API. Cleanup verifies channel deletion                                                                                         | SDK work       |
| `test:live:optional-tools`                                                | Builders and prefix-command lifecycle                                                                          | Temporary channel and test-bot command/reply messages. No human or member actions                                                                                                                        | SDK work       |
| `test:live:event-waits`                                                   | Filtered event waits and failure cleanup                                                                       | One journaled temporary channel and bot messages, with raw readback and verified channel removal                                                                                                         | SDK work       |
| `test:live:command-arguments`                                             | Typed commands and invalid-input recovery                                                                      | One journaled temporary channel and bot messages, with raw reply readback and verified channel removal                                                                                                   | SDK work       |
| `test:live:command-help`                                                  | Help pagination and delivery                                                                                   | One journaled temporary channel and bot messages, with raw page readback and verified channel removal                                                                                                    | SDK work       |
| `test:live:command-groups`                                                | Nested commands and scoped help                                                                                | One journaled temporary channel and bot messages/replies, with raw readback and verified channel removal                                                                                                 | SDK work       |
| `test:live:message-fields`                                                | Message projections                                                                                            | One journaled temporary channel, bot messages and a small attachment, with reply/edit/pin operations, raw readback and verified channel removal                                                          | SDK work       |
| `test:live:consumer-features`                                             | Forwarding, embeds, file metadata, flags and profiles                                                          | Journaled temporary channel/messages and uploads, test-owned response loss. Profile reads target only the designated bot and may trigger provider expired-premium cleanup                                | SDK work       |
| `test:live:typing`                                                        | One-shot typing, scoped refresh and completion/cancellation cleanup through both APIs                          | Temporary channel/messages and ephemeral typing notices. Does not prove inbound typing delivery                                                                                                          | SDK work       |
| `test:live:typing:interactive`                                            | Human-visible outgoing typing and selected-member inbound events through both APIs                             | Temporary channel and typing notices, with awaited refresh shutdown and verified channel removal                                                                                                         | Person present |
| `test:live:roles:reset`                                                   | Guild-wide role-display reset and lost-response reconciliation through both APIs                               | Two temporary zero-permission roles and whole-guild display reset, with existing display assignments required to be null                                                                                 | Per run        |
| `test:live:recovery`                                                      | Forced socket loss, resume, diagnostics and subsequent receive/reply                                           | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:recovery:cancel`                                               | Managed cancellation during recovery and socket cleanup                                                        | Test-socket termination, no server-content changes                                                                                                                                                       | SDK work       |
| `test:live:management`                                                    | Remote fetch, edit and deletion                                                                                | Temporary channel/messages and test-message edits/deletions                                                                                                                                              | SDK work       |
| `test:live:batch-delete`                                                  | Explicit message batches, events/cache, missing IDs and lost-response reconciliation                           | Temporary channel/messages and test-owned response loss                                                                                                                                                  | SDK work       |
| `test:live:moderation:default`, `test:live:moderation:effect`             | Timeout/clear, kick, ban expiry/unban, events and lost-response reconciliation                                 | Authorized disposable member moderation, temporary channel/messages, test-owned response loss                                                                                                            | Person present |
| `test:live:webhooks`                                                      | Webhook management, delivery and credential revocation                                                         | Temporary webhooks, channels/messages, file uploads and test-owned response loss                                                                                                                         | SDK work       |
| `test:live:announcements`                                                 | Announcement following, publishing, conversion and recovery                                                    | Journaled temporary channels, follower webhooks and messages, with test-owned response loss and verified removal                                                                                         | SDK work       |
| `test:live:expressions`                                                   | Emoji/sticker lifecycle, source-guild reads, gateway updates, partial batches and sticker messages             | Journaled temporary expressions and a channel, with verified test-owned removal and no media purging                                                                                                     | SDK work       |
| `test:live:invites`                                                       | Invite lifecycle and recovery                                                                                  | Temporary channel and invites. No invite acceptance or membership changes                                                                                                                                | SDK work       |
| `test:live:administration`                                                | Server settings and filtered audit logs                                                                        | Temporary sandbox server renaming, restoration, audit records and test-owned response loss                                                                                                               | SDK work       |
| `test:live:guild-features`                                                | Clone opt-ins and feature restoration                                                                          | Temporary sandbox cloning permissions and owner-crown visibility, audit records and verified restoration                                                                                                 | SDK work       |
| `test:live:vanity`                                                        | Custom-invite reads, read recovery and disabled-feature rejection through both APIs                            | No intended successful mutation, uses a reserved code for rejection checks                                                                                                                               | SDK work       |
| `test:live:vanity:mutate:default`, `test:live:vanity:mutate:effect`       | Manual custom-invite lifecycle and lost-response reconciliation                                                | Temporary custom codes on an eligible sandbox with no existing code                                                                                                                                      | Per run        |
| `test:live:discovery`                                                     | Directory search, categories, eligibility/status and read recovery through both APIs                           | Read-only, never submits an application                                                                                                                                                                  | SDK work       |
| `test:live:member-search`                                                 | Indexed member search and permissions                                                                          | Resource reads and search requests, which can trigger provider lazy indexing. No member moderation or role/channel edits                                                                                 | SDK work       |
| `test:live:members`                                                       | Authorized target-member nickname set, independent readback and restoration through both APIs                  | Temporary nickname change for one currently authorized non-owner member                                                                                                                                  | Per run        |
| `test:live:guild-lifecycle`                                               | Bot membership pages and bounded traversal through both APIs                                                   | Read-only. Leaving requires the separate direct command                                                                                                                                                  | SDK work       |
| `test:live:discovery:mutate:default`, `test:live:discovery:mutate:effect` | Manual directory application lifecycle and lost-response reconciliation                                        | Real review-queue submission or immediate public listing, then test-owned withdrawal                                                                                                                     | Per run        |
| `test:live:users:default`, `test:live:users:effect`                       | Public user reads, private conversations, bot server-profile edits and message failure reconciliation          | Test DMs, authorized group messages/renaming, bot profile changes and test-owned response loss                                                                                                           | Per run        |
| `test:live:events`                                                        | Gateway delivery after raw API mutations                                                                       | Temporary channel/messages and test-message edits/deletions                                                                                                                                              | SDK work       |
| `test:live:reactions`                                                     | Reactions, collectors and recovery                                                                             | Temporary channel/messages, reactions and guild emoji, plus test-socket termination                                                                                                                      | SDK work       |
| `test:live:pins`                                                          | Pin/unpin, explicit pages, pin status/events and recovery                                                      | Temporary channel/messages and pins, server-created pin notices, plus test-socket termination                                                                                                            | SDK work       |
| `test:live:guilds`                                                        | Guild/member reads, role lifecycle, caches and recovery                                                        | Temporary channel/messages, two zero-permission test roles with assignment only to the designated bot, plus test-socket termination and test-owned response loss                                         | SDK work       |
| `test:live:guild-events`                                                  | Bot-session guild create delivery after READY                                                                  | Read-only gateway connection to the existing sandbox guild. Fails when it is unavailable or the bounded event wait expires                                                                               | SDK work       |
| `test:live:voice`                                                         | Initial voice snapshots and member mute/deaf flags through both built APIs                                     | Read-only sandbox gateway/member observations. No participant moderation, joining or media                                                                                                               | SDK work       |
| `test:live:voice-controls:default`, `test:live:voice-controls:effect`     | Manual selected-participant move/disconnect and mute/deafen controls, with snapshots, events and REST readback | Temporary voice channel and participant state changes, followed by participant rejoin, baseline restoration and verified channel removal                                                                 | Person present |
| `test:live:channels`                                                      | Channel lifecycle, overwrites, audit logs and recovery                                                         | Temporary channels/categories, overwrites targeting only the bot and test guild's everyone role, test-socket termination and test-owned response loss                                                    | SDK work       |
| `test:live:history`                                                       | Explicit history pages checked against API readback                                                            | Temporary channel and messages                                                                                                                                                                           | SDK work       |
| `test:live:cleanup`                                                       | Guild summaries, hierarchy and bounded message cleanup                                                         | Temporary channel and test-bot messages, with one lost batch response. Uses the existing channel recovery journal and verifies test-owned cleanup                                                        | SDK work       |
| `test:live:own-history`                                                   | Channel-wide own-history deletion, lost-response and cancellation reconciliation through both APIs             | Two journaled temporary channels and bot messages, with verified channel removal. Guild-wide deletion requires the separate direct command                                                               | SDK work       |
| `test:live:search`                                                        | Bounded contextual indexed-message search, explicit indexing and cache exclusion                               | Temporary channel/messages. May report a hosted indexing timeout                                                                                                                                         | SDK work       |
| `test:live:pagination`                                                    | History/member/reactor/pin traversal and cleanup                                                               | Temporary channel/messages, reactions and pins, plus test-owned transient read failure and delayed response delivery                                                                                     | SDK work       |
| `test:live:cache`                                                         | Cache intake, expiry and recovery invalidation                                                                 | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:collectors`                                                    | Collector completion, gap failure and use after recovery                                                       | Temporary channel/messages and test-socket termination                                                                                                                                                   | SDK work       |
| `test:live:embeds`                                                        | Embed send/reply/edit, readback, events, cache and collectors                                                  | Temporary channel/messages and test-message edits                                                                                                                                                        | SDK work       |
| `test:live:attachments`                                                   | Uploads, binary readback, file edits, events/cache/collectors and recovery                                     | Temporary channel/messages, 50 MiB file upload/download, file replacements and test-socket termination                                                                                                   | SDK work       |
| `test:live:attachment-sources`                                            | File/stream uploads, URL refresh and bounded download recovery                                                 | Temporary channel/messages, one test-owned temporary file and delayed-EOF wrapper. The injected 403 targets only the current channel's unique attachment plan and does not change provider configuration | SDK work       |

## Direct harness commands

Run each command with `default` and then `effect` unless stated otherwise

| Command                                                        | Purpose and outside effects                                                                                                                                                                                                                                | Authorization  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `node tests/live/bot-runner.js default`                        | Public bot runner against the sandbox. Checks synchronous misuse rejection, interrupts only its own gateway connection, cancels during recovery and fails a test-owned setup callback, then verifies client, socket and signal-listener cleanup. Read-only | SDK work       |
| `node tests/live/text-validation.js default`                   | Local rejection, normalized UTF-16 boundary writes and reconciliation of an intentionally lost edit response without replay. One journaled zero-permission role per mode, with no human membership or existing role changed                                | SDK work       |
| `node tests/live/recovery-window.js default`                   | Gateway recovery window of at least 165 seconds per mode, interrupting only its own authenticated sockets, including one locally delayed Hello frame. No server mutations                                                                                  | SDK work       |
| `node tests/live/recovery-window.js default --session-restart` | SessionStore shutdown followed by a new client that must receive RESUMED rather than READY within the retention window. Uses only its own sockets and in-memory store, with verified sandbox identity and no server mutations                              | SDK work       |
| `node tests/live/sdk.js default --quality`                     | Local validation rejection and user/private-channel cache reads for an authorized member and group. No messages or remote state changes                                                                                                                    | Per run        |
| `node tests/live/users.js default --latest-only`               | Latest-private-message batch failure/recovery with marker-owned test DMs. No profile, presence or group changes                                                                                                                                            | Per run        |
| `node tests/live/own-history.js default --guild`               | Irreversible deletion of every message the designated bot authored in the sandbox server                                                                                                                                                                   | Per run        |
| `node tests/live/guild-lifecycle.js default --leave`           | The bot leaves the server, with membership-list verification. Add `--lose-response` to discard the successful response and verify reconciliation without replay                                                                                            | Person present |
| `node tests/live/voice-controls.js default --flags-only`       | Mute/deafen checks without moving or disconnecting the participant. Use `--no-move` instead to include disconnect and rejoin without creating a channel                                                                                                    | Person present |

## Check requirements

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

The harness verifies identity and membership and journals its test-owned channels.
An existing journal triggers recovery only, without repeating whole-history deletion.
Cleanup removes only the journaled channels and cannot restore deleted history.
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
Supply the account ID through `FLUXER_TEST_MODERATION_USER_ID`. A missing or invalid ID fails before live requests.
The account must be a current non-owner, non-administrator member without an existing timeout or ban.
Run each moderation mode separately and re-add the account between runs.
The checks never delete its messages and leave it unbanned, but cannot restore its membership or previous roles

Before each leave invocation, coordinate with the person who can re-add the bot, and supply the currently authorized `FLUXER_TEST_LEAVE_GUILD_ID` in the process environment.
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

- Verify bot, application and server identity, and take the sandbox lock, before live requests
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
