---
title: Create a Fluxer bot and get its token
navTitle: Create a bot
description: Create the application, copy its token and invite the bot to a community
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

## 2. Copy the token

On the application's page, the **Secrets & tokens** section shows the **Bot token**. Fluxer shows the token only right after the application is created or after **Regenerate**, so copy it now and keep it somewhere private, such as a password manager, until the [quick start](/docs/{{version}}/quick-start/) saves it in the bot's `.env` file. Anyone holding the token can act as the bot, so keep it out of source code, chat messages, screenshots and logs

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

## Next

Continue with the [quick start](/docs/{{version}}/quick-start/) to generate the project, save the token in it and answer `!ping`
