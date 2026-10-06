---
title: Create a Fluxer bot and get its token
navTitle: Create a bot
description: Create the application, store its token and invite the bot to a community
---

A Fluxer bot is an application with its own bot account. This page creates the application, keeps its token private and adds the bot to a community, which is what the API calls a [guild](/docs/{{version}}/glossary/#guild). The [quick start](/docs/{{version}}/quick-start/) then makes the bot answer its first command

## What is needed

- Node.js 24.15 or newer, which Fluxerly is tested against. Run `node --version` to check
- A registered Fluxer account. If the Fluxer app shows **Claim account**, use it first to add an email and password, because an unclaimed account cannot create applications
- A community where that account has the `ManageGuild` or `Administrator` permission, such as a private test community

## 1. Create the application

1. Sign in to Fluxer with the account that should own the bot
2. Open **User settings** with the gear button next to the microphone and speaker buttons
3. Under **Developer**, choose **Applications**
4. Choose **Create application**, enter an **Application name** and choose **Create**

Fluxer creates the bot account together with the application and opens the application's page. The bot's username comes from the application name when that name is available, otherwise Fluxer picks another one

The page shows the **Application ID** with a **Copy ID** button. Note it for the invite link below. It is not secret, and the bot account's user ID is the same number

Fluxer's API reference describes [what creating an application returns](https://docs.fluxer.app/http-api/applications/#create-application)

## 2. Store the token

On the application's page, the **Secrets & tokens** section shows the **Bot token**. Fluxer shows the token only right after the application is created or after **Regenerate**, so copy it now. Anyone holding the token can act as the bot, so keep it out of source code, chat messages, screenshots and logs

Create a folder for the bot. Save the token in a file named `.env` in that folder:

```text
FLUXER_BOT_TOKEN=paste-the-token-here
```

Check that the file is named exactly `.env`. Some editors, such as Notepad, add `.txt` when saving, and Node.js cannot find `.env.txt`

Keep that file out of version control by adding this line to `.gitignore`:

```text
.env
```

<details>
<summary>If the token leaks or gets lost</summary>

Choose **Regenerate** next to the bot token. The old token stops working at once, and every running copy of the bot is disconnected. Put the new token in `.env` and start the bot again

A token has the form `<application_id>.<secret>`, so the part before the dot is the application ID. Fluxer's [token formats](https://docs.fluxer.app/authentication/#token-formats) and [credential handling](https://docs.fluxer.app/authentication/#credential-handling) notes cover the details

</details>

## 3. Invite the bot to a community

An invite link opens Fluxer's page for adding the bot to a community. The quick start needs three [permissions](/docs/{{version}}/guilds-and-permissions/):

- `ViewChannel`, to see the channel where a command is typed
- `SendMessages`, to reply
- `ReadMessageHistory`, to read earlier messages in the channel

Together these make the permission value 68608. Replace `APPLICATION_ID` in this link with the application ID, then open it in a browser:

```text
https://api.fluxer.app/v1/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=68608
```

Fluxer asks which account to use, then which community to add the bot to, and shows the requested permissions. Choose **Authorise** on the last step. Fluxer creates a role named after the application with exactly these permissions and gives it to the bot

The application's page also has an **OAuth2 URL builder** section that builds such a link from chosen scopes and **Bot permissions**

<details>
<summary>If the bot cannot be added</summary>

- Adding a bot needs the `ManageGuild` or `Administrator` permission in the chosen community
- Only an administrator can give the bot a permission that the person adding it does not have
- A private bot can be added only by the account that owns the application
- A bot that is already in the community cannot be added again

The role Fluxer creates for the bot stays in the community if the bot leaves. The [consent step](https://docs.fluxer.app/http-api/oauth2/#grant-oauth2-consent) in Fluxer's API reference lists every outcome

</details>

Optionally, once the quick start has installed the SDK, `links.installation` builds the same link in code. It checks the ID and the permission names, so a typo fails instead of producing a broken link:

```ts
import { links, permissionBits } from "@neontechspace/fluxerly"

const applicationId = process.argv[2] ?? ""
const permissions = permissionBits.from(["ViewChannel", "SendMessages", "ReadMessageHistory"])
console.log(links.installation(applicationId, { permissions }))
```

Save it as `invite.js` in the bot's folder, or `invite.ts` for TypeScript, and run it with the application ID, such as `node invite.js 1234567890123456789`

## 4. Pass the token to the bot

The bot reads its token from the `FLUXER_BOT_TOKEN` environment variable. Node.js can load that variable from `.env` when it starts. Once the quick start has created the bot file, run it like this:

```command
{"kind":"run","command":"node --env-file=.env bot.js"}
```

<details>
<summary>Set the variable in the terminal instead</summary>

In bash or zsh, run `export FLUXER_BOT_TOKEN="paste-the-token-here"`, then start the bot with `node bot.js` in the same terminal.
In PowerShell, run `$env:FLUXER_BOT_TOKEN = "paste-the-token-here"`, then `node bot.js`

The variable lasts until the terminal closes. The typed command can stay in the shell's history, so prefer `.env` on shared machines

</details>

## 5. Check the project setup

- The SDK is ESM-only. Load it with `import`, and set `"type": "module"` in `package.json`, which the quick start creates. Loading it with `require()` fails with an error that says so
- Node.js 24.15 or newer runs both `bot.js` and `bot.ts` directly, without a build step
- TypeScript projects that typecheck their code also need Node.js type definitions and a `tsconfig.json`, as the next section shows

### TypeScript setup

The SDK's types use Node.js types, such as the `AbortSignal` passed to handlers. Install them as a development dependency:

```command
{"kind":"dev","package":"@types/node"}
```

Then save this as `tsconfig.json` next to the bot:

```json
{
    "compilerOptions": {
        "target": "ES2024",
        "module": "NodeNext",
        "types": ["node"],
        "strict": true,
        "noEmit": true,
        "allowImportingTsExtensions": true,
        "verbatimModuleSyntax": true,
        "erasableSyntaxOnly": true
    }
}
```

Node.js removes the types itself when it runs a `.ts` file, so TypeScript only checks the code and writes no output. The last three settings keep the code in a form Node.js can run directly: Imports of other files may use their `.ts` extension, type-only imports need `import type`, and TypeScript features that generate code, such as `enum`, are reported. To run the check, install the `typescript` package, version 7, as another development dependency and run `npx tsc`

## Next

Continue with the [quick start](/docs/{{version}}/quick-start/) to install the SDK and answer `!ping`
