---
"@neontechspace/fluxerly": patch
---

Keep the original thrown value of an attachment stream cleanup failure that no caller observed. Client shutdown reports up to 64 retained failures with their values, and later ones are counted without their values
