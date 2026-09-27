---
title: Deploy a bot
navTitle: Deploying
description: Keep a bot running with PM2, systemd or Docker, with the token in the environment and a clean shutdown
---

A deployed bot is an ordinary Node.js process. A process manager starts it, passes the token through the environment, restarts it after a crash and stops it with a signal: SIGINT under PM2 and SIGTERM under systemd and Docker. With `processSignals: true`, the SDK handles both signals, closes the connection cleanly and lets the process exit

## Prepare the bot

Every setup below expects the same project:

- Node.js 24.15 or newer on the server or in the image
- The `"type": "module"` field in `package.json`, because the SDK is ESM-only
- The `processSignals: true` option in `runBot`, so SIGINT and SIGTERM stop the bot cleanly
- The token read from `process.env.FLUXER_BOT_TOKEN`, never written in a source file, committed to version control or copied into an image
- No extra exit handling: When a failure stops the bot, `runBot` sets `process.exitCode` to 1, so the process manager can tell a crash from a normal stop

For local runs, keep the token in a `.env` file that version control ignores, and let Node.js load it

```sh
node --env-file=.env bot.js
```

The file holds one `KEY=value` line per variable. Write the value without quotes so Docker's `--env-file` reads the same file correctly

```text
FLUXER_BOT_TOKEN=paste-the-token-here
```

For TypeScript, run `bot.ts` instead of `bot.js`. Node.js 24 runs TypeScript files directly, so no build step is required

## What happens on shutdown

With `processSignals: true`, the SDK listens for SIGINT and SIGTERM and for no other signals. When the process receives one of them, the SDK logs the signal and shuts the bot down:

- Stops accepting new events and gives running handlers and commands, the events already waiting for them and their requests up to 5 seconds to finish. The `drainMs` option of `runBot` changes that time, and `drainMs: 0` skips the wait
- Signals the handlers still running to stop through their `signal`
- Closes the command router and every event subscription
- Closes each gateway connection, giving it up to 5 seconds to close normally
- Waits for the SDK's own cleanup of sockets, requests and collector callbacks, and saves resumable sessions when a [session store](/docs/{{version}}/sharding/#resume-after-a-restart) is configured
- Finally logs `Shutdown complete` with its duration, removes its signal listeners and resolves the `runBot` Result

The SDK never calls `process.exit`. The process exits once nothing else keeps Node.js running, so close database connections, timers and servers the application opened after `runBot` resolves. Promises started by handlers are not awaited, so track work that must finish before exit, as shown in [application supervision](/docs/{{version}}/application-supervision/#drain-application-owned-work)

Give the process manager a stop timeout of at least 10 seconds before it force-kills the bot: Up to 5 seconds for running handlers and up to 5 seconds to close the connection. Allow more when `drainMs` is larger. Each listener handles only the first signal of its kind, so sending the same signal again during shutdown gets Node.js's default handling and usually ends the process at once

## Logs

The SDK writes Info and Debug records to standard output and warnings and errors to standard error. When output is not a terminal, as under every setup below, each record is one JSON object per line, ready for a log collector. Set `FLUXERLY_LOG_FORMAT=pretty` in the environment for readable lines instead. The [logging guide](/docs/{{version}}/logging/) covers levels and categories

## Run with PM2

PM2 reads an ecosystem file. Because the project uses `"type": "module"`, name it `ecosystem.config.cjs`

```cjs
module.exports = {
    apps: [
        {
            name: "fluxer-bot",
            cwd: __dirname,
            script: "bot.js",
            node_args: "--env-file=.env",
            exp_backoff_restart_delay: 1000,
            kill_timeout: 10000,
        },
    ],
}
```

PM2 restarts the bot whenever it exits, and `exp_backoff_restart_delay` makes it wait longer after each quick failure. PM2 stops an app by sending SIGINT and force-kills it after `kill_timeout`, whose default of 1.6 seconds is shorter than a graceful gateway close

```sh
pm2 start ecosystem.config.cjs
pm2 logs fluxer-bot
pm2 save
```

The `pm2 save` command records the running apps, and `pm2 startup` prints the command that starts PM2 again after a reboot

## Run with systemd

Create a unit file such as `/etc/systemd/system/fluxer-bot.service`

```ini
[Unit]
Description=Fluxer bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=fluxer-bot
WorkingDirectory=/srv/fluxer-bot
EnvironmentFile=/etc/fluxer-bot.env
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Put `FLUXER_BOT_TOKEN=...` in `/etc/fluxer-bot.env`, owned by root and readable only by root (`chmod 600`). The service manager reads the file before starting the service, so the bot's own user does not need access to it. Adjust the `node` path to the output of `command -v node`

By default, systemd stops a service with SIGTERM and waits `TimeoutStopSec` before force-killing it. The `Restart=on-failure` setting restarts the bot after a non-zero exit code or a crash, but not after a clean stop

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now fluxer-bot
journalctl -u fluxer-bot -f
```

For a [supervisor](/docs/{{version}}/sharding/#run-shards-in-several-processes) that runs child processes, add `KillMode=mixed` so SIGTERM reaches only the parent, which then stops its children

## Run with Docker

Keep the token and local files out of the image with a `.dockerignore` file next to the `Dockerfile`

```text
.env
node_modules
```

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "bot.js"]
```

The `node:24-slim` image tracks the newest Node.js 24 release. Adjust the copy and install lines for pnpm or another lockfile

```sh
docker build -t fluxer-bot .
docker run -d --name fluxer-bot --init --restart unless-stopped --env-file .env fluxer-bot
docker logs -f fluxer-bot
```

The token reaches the container only at run time through `--env-file`. The `--init` flag runs a small init process that forwards signals to Node.js. The `docker stop` command sends SIGTERM and force-kills the container after 10 seconds, and `--stop-timeout 30` on `docker run` allows longer. With `--restart unless-stopped`, Docker restarts the bot after it exits unless it was stopped on purpose

## Restart policy

Restart after a crash, but with a delay: A bot that fails at startup, for example with a rejected token, fails again at once. Each setup above adds one: PM2 through `exp_backoff_restart_delay`, systemd through `RestartSec` and Docker through its own growing restart delay. Each restart creates a new client and a new gateway session. Events that arrived while the bot was down are not replayed unless a [session store](/docs/{{version}}/sharding/#resume-after-a-restart) lets a quick restart resume the previous session

<details>
<summary>Which failures end the process?</summary>

The SDK keeps the bot running through handler failures, dropped events and lost connections, and reconnects on its own.
The `runBot` Result fails, and the process exits with code 1, for a startup failure such as a rejected token or an unreachable instance, a connection failure the SDK cannot recover from, or a failed `setup` callback.
Invalid options throw `ConfigurationError` before connecting.
The [reliability guide](/docs/{{version}}/reliability/) and [troubleshooting](/docs/{{version}}/troubleshooting/) explain these failures

</details>
