---
"@neontechspace/fluxerly": patch
---

Return the received failure at once when a GET retry after a network error or HTTP 500, 502, 503 or 504 could not start before the operation deadline, such as a long `Retry-After`. Such a read previously waited for the whole deadline and failed with reason `timeout`
