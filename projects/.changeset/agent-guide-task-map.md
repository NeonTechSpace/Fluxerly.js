---
"@neontechspace/fluxerly": patch
---

The shipped agent guide in `agents/AGENTS.md` now maps common bot tasks, such as sending messages, moderating members, checking permissions and testing, to the declaration file and members that cover them, instead of pointing agents at the re-export file `dist/index.d.ts`. It sends agents who need the website to its task index and method-by-task list first, and explains how to tell whether those pages match the installed version. The section `fluxerly agents` writes names the installed package's manifest as the place to compare versions and mentions the task map
