---
"@neontechspace/fluxerly": minor
---

Credential masking covers much more. It applies to log records, `describeError`, `FailureReport.describe()`, `toJSON()` and `ApplicationError` messages. Masking covers Fluxer's credential forms and common credential names. A secret of another service under a name or in a link format it does not know may stay readable, so keep such secrets out of error messages. The docs now promise masking for recognized credentials only, and the `LoggingOptions` reference no longer says that records never contain credentials

Newly masked in error names, messages, stacks and causes:

- Passwords, cookies and API keys: Values after `password=`, `passwd=`, `api_key=` or a quoted key such as `"password":`, a quoted value after an unquoted key such as `password: 'x'` in an inspected object, and the value of a `Cookie` or `Set-Cookie` header. A quoted value is masked whole, with its spaces, punctuation and escaped quotes. Cookie values are masked in header lines, also when a cookie value is quoted, and in inspected or JSON headers, including a `set-cookie` array, Node's `rawHeaders`, a fetch `Headers` object and a `Map`. These used to appear in full in normal Error records
- Headers: `Authorization`, `Proxy-Authorization` and `X-API-Key` headers are masked in every form a `Cookie` header is: Header lines, quoted values, arrays, `Map` entries and header pair lists, whatever the scheme or length of the value. Credential names ignore case, `-` and `_`, so `X-API-Key`, `api-key=` and `"x-api-key":` are masked like `api_key`. Credentials after `bearer`, `BEARER` or `basic` are masked in any letter case
- Cookie lists: `cookies` values, such as a parsed cookie object or a list of cookie strings, and Express `signedCookies` values
- OAuth: The OAuth code in a `URLSearchParams` value, in a parsed callback query such as Express `req.query` or `querystring.parse` output with a `state` field, and in a token exchange form body that starts with `code=`, and the PKCE `codeVerifier`. A lone `code` such as `ECONNRESET` stays readable
- Signed links: The signature and credential of a signed upload URL, such as `X-Amz-Signature=`, without an `upload_url` label, the `hm` signature of a Fluxer attachment link, the signature of an Azure SAS link (`sig`) and of a Google V2 or CloudFront signed link (`Signature`), and any signed JSON token such as a JWT or an upload relay token. These stay hidden after the link is split into an object, a `Map` or a list of entries, such as `Object.fromEntries(url.searchParams)` or a parsed query. The date, expiry, algorithm, permissions and access ID of a signed link, such as `X-Amz-Expires`, `ex` and `is`, stay readable, and a `signature` field outside a signed link, such as an email signature, stays readable
- Cloud keys: An AWS `secretAccessKey`, in any spelling such as `AWS_SECRET_ACCESS_KEY`, and a `privateKey` such as a service account's `private_key`. An AWS `sessionToken` was already hidden. The access key ID stays readable
- Invite codes: The code of an Error shaped like an invite, invite codes in decoded invite audit entries, such as those from `auditLogs.fetchPage`, as the raw entry already had, an invite link with capital letters, such as `Fluxer.gg/...`, the `sourceInviteCodes` filter name and a labelled URL with several query parameters

Masking now reaches more kinds of values:

- A thrown or failed value that is not an Error is masked before it becomes text. Values under credential keys such as `upload_url`, `vanity_url_code` or `password`, invite codes in invite-shaped objects, header values in a `Map` and the value after a header name in Node's `rawHeaders` or a header pair list used to appear in full in normal Error records
- An Error, a proxy or an object with its own inspection method, when it is thrown or sits inside a thrown value. Their properties, causes and what their inspection returns follow the same key policy as plain objects, so an invite code, a password or a signed upload URL there is hidden. A `URL` object inside a thrown value prints as its masked text, so an OAuth code in its query is hidden
- JSON written into an error message or a thrown string, also inside a JSON string, follows the payload key policy: A credential key hides its whole value, objects included, an escaped key such as `"cookie"` counts as its decoded name, and an invite-shaped object hides its code. Escaped text is masked whatever quotes come before it and however deeply it is escaped
- A credential inside escaped quotes is masked, such as a quoted password in a scheduled task name, in a thrown string quoted by an `ApplicationError` message, or in a JSON body written inside a JSON string. Readable text inside escaped quotes stays as written
- Text printed by Node's `util.inspect`, whose keys have no quotes, such as `{ hm: 'x' }` or `[Object: null prototype] { code: 'x', state: 'x' }`, gets the same key rules as JSON text, so the `hm` of a Fluxer attachment link, an OAuth code beside `state` and an invite code are hidden there too. The whole value of a credential key is hidden when inspection splits it, such as a PEM `privateKey` written as quoted lines joined by `+`, or writes it in backticks, as it does for text with both quote kinds. Only the first part used to be hidden
- A thrown string is masked before an `ApplicationError` message cuts it at 200 characters
- Record facts such as `route`, `event`, `command` and `subscriptionId` are masked like other text

Readable text stays readable:

- Describing a thrown object no longer calls its getters, so a getter that throws or has side effects cannot change or hide the rest of the description. The same object referenced twice is shown twice instead of as a cycle
- A list of header names such as `["Authorization", "Cookie", "X-API-Key"]`, a pair of names such as `["password", "username"]` and prose such as `Missing "Authorization", check the header` stay readable
- A header name such as `X-Trace-ID` in a list of missing headers, prose after a header label such as `Cookie: not present`, a dotted name such as `Bot application.commands.update`, and a short numeric query code such as `?code=404` stay readable
- Header names in a list whose key names header names, such as `missingHeaders` or `allowedHeaders`, stay readable in logs and `describeError` when they are lowercase, as `Headers` keys are. A value with digits, spaces or other punctuation after a credential header name in such a list is still hidden, and other header pair lists are masked as before
- A credential field or header that is missing reads as missing instead of `[redacted]`: An `undefined`, `null`, empty or boolean value under a credential key, and header text such as `Authorization: missing` or `Cookie: invalid`

Unsafe payload logging now masks:

- Invite codes in invite audit log entries, in their target ID and code changes, `vanity_url_code` change values in any audit entry, and the code of an `INVITE_DELETE` dispatch, also in a cut off REST body
- The signed `upload_url` of attachment upload plans, and the vanity code in the request body that sets it
- The community invite codes of member search, in the `source_invite_code` filter that is sent and in each hit's supplemental data, also in a cut off response

These used to appear in full in gateway and REST payload records
