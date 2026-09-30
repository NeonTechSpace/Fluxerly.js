---
"@neontechspace/fluxerly": patch
---

Release event handler slots and partition keys after a synchronous handler or middleware throw, including when middleware calls next. The failure is reported once and the invocation emits its failure observation without blocking later events

Keep guards returning false silent under automatic rejection feedback, including the runBot reply default. Rejection counters, Debug records and custom onReject callbacks still receive the denial, while guards returning an explicit deny reason retain their reply

Include the matched command's canonical name and reported failure in each command router observation, with one observation spanning event and command middleware. Interrupted commands report cancelled, and messages with no command match remain unnamed observations. Command failure metrics use the same name and command spans cover middleware, guards and execution
