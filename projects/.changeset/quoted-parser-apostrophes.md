---
"@neontechspace/fluxerly": major
---

Breaking changes in `commands.parseQuoted`: A single quote is now an apostrophe unless it starts a word, and its rejections carry the command `name`. Double quotes, backslash escapes and the rejections for an unclosed quote and a trailing backslash are otherwise unchanged. A single quote opens a quoted span only at the start of the text, after whitespace or directly after a span that just closed. Inside a single-quoted span, a single quote ends the span unless the next character is a letter or digit, so the end of the text, whitespace, quotes and punctuation all end it. Every other single quote is literal.

Inputs that now parse differently, shown as the words each gives (arguments after `!say `):

- `don't` and `it's Ada's`: Now `don't`, then `it's` and `Ada's`. Before, the apostrophe opened a span, so `don't` was rejected as an unclosed single quote and `it's Ada's` gave the one word `its Adas`
- `a'b c'` and `key='a b'`: Now `a'b` with `c'`, and `key='a` with `b'`. Before, `ab c` and `key=a b`
- `a''b`, `a'b'c` and `a'`: Now unchanged as `a''b`, `a'b'c` and `a'`. Before, `ab`, `abc` and an unclosed single quote
- `'it's fine'`, `'don't'` and `'x'y'`: Now `it's fine`, `don't` and `x'y`. Before, all three were rejected as an unclosed single quote
- `'the dogs' bowl'`: Now `the dogs` and `bowl'`. Before, rejected as an unclosed single quote
- `'a'b`, `'a b'c`, `''a`, `'a'1` and `'日本'語`: Now rejected as an unclosed single quote, because the second quote is followed by a letter or digit and so stays inside the span. Before, `ab`, `a bc`, `a`, `a1` and `日本語`
- `a' 'b` and `x'y 'z`: Now rejected as an unclosed single quote, because the first apostrophe no longer opens a span and the later quote does. Before, `a b` and `xy z`

Inputs that parse as before include `'Yes', 'No'` (`Yes,` and `No`), `'a'.`, `'a'-b`, `'a' 'b'`, `'a''b'` (`ab`), `don\'t` and every input without a single quote.

Rejections that `commands.parseQuoted` returns for an unclosed quote and a trailing backslash now also carry `name`, the command name read before the mistake, so a reply can say which command it was for. A parse and a rejection can therefore both carry `name`, and a caller that told them apart with `"name" in result` must use `"reason" in result` instead.

To migrate, remove workarounds such as `don\'t`, which still works but is no longer needed. Wrap values that follow text in double quotes, such as `key="a b"`, and end a single-quoted span before whitespace or punctuation, not before a letter or digit, or use double quotes, which may touch text, such as `"a"b`. A word that begins with an apostrophe, such as `'twas`, still opens a span, so write it as `\'twas`.
