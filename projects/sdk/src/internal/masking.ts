/**
 * Credential masking: The only module that turns values into output text for logging, failure reports and error text.
 * Invariant: Text, meaning record messages, text fields and error text, masks configured secrets, bare bot tokens,
 * Authorization, Proxy-Authorization, Cookie, Set-Cookie and X-API-Key header values in every container form, token-shaped
 * Bot, Bearer and Basic values in any letter case, labelled credentials such as password=, cookies=, a PKCE verifier, "apiKey": or an AWS
 * secretAccessKey, OAuth codes in query strings, form bodies and parsed callback queries, the signatures of signed links
 * such as X-Amz-Signature, the sig of an Azure SAS link, the Signature of a Google V2 link and the hm of a Fluxer
 * attachment link, also after the link is split into an object, Map or entry list, signed JSON tokens such as a JWT or an
 * upload relay token anywhere, webhook URL tokens, invite links and URL user information, also inside JSON string
 * literals that hold escaped quotes and in inspected text, whose keys have no quotes.
 * A value that is not text is copied with values under credential keys, header pair values and invite codes masked before it
 * becomes text, and payloads use the same copy. One key policy applies to text and structure: Case, - and _ are ignored.
 * A credential key whose value is undefined, null, empty or a boolean keeps it, so a missing header reads as missing.
 * Every export returns masked text, and describing any value never throws.
 * Not covered: An unlabelled secret in free text, such as a password written without a label, and another service's
 * credential under a name or in a link format not listed here. The contents of binary
 * values such as Buffer and Uint8Array, which inspection prints as bytes. Context the caller adds to its own records,
 * such as Effect log annotations, and hints the caller writes on a ConfigurationError, which are trusted as written.
 * This module has no SDK imports, so the error classes can use it without an import cycle. Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
import { inspect, types } from "node:util"

const redacted = "[redacted]"

/** A key in its policy form: Lowercase, without - and _, so X-API-Key, api_key and apiKey are the same name */
const policyKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "")

/** Signing parameters of signed links: AWS and Google V4 query signing, and the hm signature of a Fluxer attachment link.
 * The same list hides them by key in every container and after ? or & in text. Expiry, date and algorithm parameters
 * such as X-Amz-Expires, ex and is carry no secret and stay readable
 */
const signingParameters = [
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "X-Goog-Signature",
    "X-Goog-Credential",
    "hm",
]
/** Credential keys, in policy form, that no ending below covers */
const sensitiveKeys = new Set([
    "authorization",
    "proxyauthorization",
    "cookie",
    "cookies",
    "setcookie",
    "signedcookies",
    "vanityurlcode",
    "uploadurl",
    "sourceinvitecode",
    "sourceinvitecodes",
    "codeverifier",
    // The verifier that oauth.createPkce returns, and a PKCE verifier stored under that name
    "verifier",
    ...signingParameters.map((name) => policyKey(name)),
])
/** The signature of an Azure SAS link, sig, and of a Google V2 or CloudFront signed link, Signature. Their names are too
 * generic to hide alone, so text hides them after ? or & in a query, and a container hides them next to a companion
 * field below. A lone signature, such as an email signature, stays readable
 */
const signatureKeys = new Set(["sig", "signature"])
/** Fields, in policy form, that only a signed link's query holds: The version, permissions, expiry and resource of an
 * Azure SAS, the GoogleAccessId of a Google V2 link and the Key-Pair-Id of a CloudFront link
 */
const signedLinkKeys = new Set(["sv", "sp", "se", "sr", "googleaccessid", "keypairid"])
/** Whether keys are those of a signed link's query, so their sig or Signature is its signature */
const signedLinkShape = (keys: Iterable<unknown>) => {
    for (const key of keys) if (typeof key === "string" && signedLinkKeys.has(policyKey(key))) return true
    return false
}
/** Fields of an OAuth callback query or token exchange, in policy form. A code next to one of them is an authorization
 * code, while a lone code such as ECONNRESET stays readable
 */
const oauthKeys = new Set(["state", "redirecturi", "codeverifier", "granttype"])
/** Whether keys hold an OAuth field, so their code is an authorization code */
const oauthShape = (keys: Iterable<unknown>) => {
    for (const key of keys) if (typeof key === "string" && oauthKeys.has(policyKey(key))) return true
    return false
}
/** A value that cannot hold a secret, so a credential key keeps it and a missing header does not look hidden */
const absent = (value: unknown) => value === undefined || value === null || value === "" || typeof value === "boolean"
/** Whether a value under this key is hidden: The key is a credential key and the value could hold a secret */
const hiddenEntry = (key: string, value: unknown) => sensitiveKey(key) && !absent(value)
/** Whether a key holds a credential because of the fields beside it: A code in invite data or next to an OAuth field,
 * and a sig or Signature in a signed link's query
 */
const companionCredential = (key: string, codes: boolean, signed: boolean) =>
    (codes && key === "code") || (signed && signatureKeys.has(policyKey(key)))
/** Header names, in policy form, whose value follows them in a header pair list or rawHeaders array */
const headerKeys = new Set(["authorization", "proxyauthorization", "cookie", "setcookie", "xapikey"])
/** Header names that a list of names holds, such as a list of missing or allowed headers. In a pair list, an entry
 * after a credential header that is itself one of these names stays readable, because a header value is never one
 */
const headerNames = [
    "Accept",
    "Accept-Encoding",
    "Accept-Language",
    "Authorization",
    "Cache-Control",
    "Connection",
    "Content-Encoding",
    "Content-Length",
    "Content-Type",
    "Cookie",
    "Host",
    "Origin",
    "Proxy-Authorization",
    "Referer",
    "Set-Cookie",
    "User-Agent",
    "X-API-Key",
    "X-Request-ID",
]
const headerNameKeys = new Set(headerNames.map((name) => policyKey(name)))
/** Any other header name as it is usually written: Capitalized words or short acronyms joined by hyphens, such as
 * X-Trace-ID or X-RateLimit-Limit. Case-sensitive, so a random credential value practically never has this shape
 */
const headerNameShape =
    /^(?:[A-Z](?:[a-z]+(?:[A-Z][a-z]+)*|[A-Z]{0,3}))(?:-[A-Z](?:[a-z]+(?:[A-Z][a-z]+)*|[A-Z]{0,3}))+$/
/** Whether a value in a header pair position is a header name, as in a list of missing or allowed headers */
const headerName = (value: string) => headerNameKeys.has(policyKey(value)) || headerNameShape.test(value)
/** Whether text at offset sits inside an open list whose key names header names, as in missingHeaders: [ or
 * "allowedHeaders":[, looking back at most 200 characters
 */
function inHeaderNameList(text: string, offset: number): boolean {
    const before = text.slice(Math.max(0, offset - 200), offset)
    const open = before.lastIndexOf("[")
    if (open < 0 || before.includes("]", open)) return false
    const key = /([A-Za-z_][A-Za-z0-9_-]*)\\?["']?\s*[:=]\s*$/.exec(before.slice(0, open))?.[1]
    return key !== undefined && headerNameListKey(key)
}
/** Keys whose value is a list of header names, not of header pairs, such as missingHeaders or allowedHeaders */
const headerNameListKey = (key: string) =>
    /^(?:missing|required|allowed|allow|exposed|expose|expected|accepted|forbidden|unknown|unexpected|extra|vary|signed|accesscontrolallow|accesscontrolexpose|accesscontrolrequest)headers$|^headernames$/.test(
        policyKey(key),
    )
/** A header name in a list that its key names as a list of header names. Headers keys and many clients write names in
 * lowercase, such as x-trace-id, so each hyphen-joined word is capitalized before the shape check. A value with
 * digits, spaces or other punctuation, as a credential has, still counts as a header value
 */
const listedHeaderName = (value: string) =>
    headerName(value) ||
    headerNameShape.test(
        value
            .toLowerCase()
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join("-"),
    )
/** One of those names in free text, ignoring case, - and _ */
const headerNameText = `(?:${headerNames.map((name) => name.replaceAll("-", "[-_]?")).join("|")})`
const inviteShapeKeys = ["inviter", "max_uses", "temporary", "uses", "max_age"]

/** Key endings that label a credential, in a payload key or in free text such as api_key=, X-API-Key= or "botToken":,
 * including an AWS secretAccessKey or AWS_SECRET_ACCESS_KEY and a privateKey such as a service account's private_key.
 * An AWS sessionToken ends in token
 */
const credentialLabel = "(?:token|secret|password|passwd|api[-_]?key|secret[-_]?access[-_]?key|private[-_]?key)"
/** Credential names without such an ending, matched whole in free text, such as an OAuth PKCE verifier or code_verifier
 * or a set_cookie assignment. Each name that sensitiveKeys hides in a payload is hidden here too, except the signing
 * parameters, which text hides only after ? or &
 */
const credentialName =
    "(?:vanity[-_]?url[-_]?code|upload[-_]?url|source[-_]?invite[-_]?codes?|signed[-_]?cookies|(?:code[-_]?)?verifier|set[-_]?cookies?|cookies?)"
/** A key in free text that labels a credential */
const keyLabel = `(?:[A-Za-z0-9_]*${credentialLabel}|${credentialName})`

function sensitiveKey(key: string): boolean {
    const name = policyKey(key)
    return sensitiveKeys.has(name) || /(?:token|secret|password|passwd|apikey|secretaccesskey|privatekey)$/.test(name)
}

/** Authentication scheme words, lowercase, that a header value can start with */
const schemeWords = new Set(["bot", "bearer", "basic", "digest", "token", "negotiate"])
/** Whether the text after a header label is prose rather than a value, such as "not present" or "header missing": Two
 * short lowercase words that are not a scheme and a credential, or one word that says the value is absent or wrong, such
 * as missing or invalid. Case-sensitive for two words, so a value with a capital letter, digit or punctuation is never
 * prose
 */
function headerProse(after: string): boolean {
    if (/^(?:missing|absent|empty|none|null|undefined|required|invalid|expired|malformed)(?:[\s,.!?]|$)/i.test(after))
        return true
    const words = /^([a-z]{1,12}) [a-z]{1,12}(?:[\s,.;:!?]|$)/.exec(after)
    return words !== null && !schemeWords.has(words[1]!)
}

/** A quoted value, hidden whole with its escapes up to its own closing quote, or to the end of the line when it is cut
 * off. The group numbered `open` is the opening quote and the next group the closing one, empty when it is cut off
 */
const quotedValue = (open: number) => `(["'\`])(?:\\\\.|(?!\\${open})[^\\\\\\n])*(\\${open}|(?=\\n)|$)`
/** An array value, hidden whole up to its closing bracket or the end of a cut off text. The group numbered `open` holds
 * the bracket and the next group the quote of a string inside it
 */
const arrayValue = (open: number) =>
    `(\\[)(?:(["'\`])(?:\\\\.|(?!\\${open + 1})[^\\\\\\n])*\\${open + 1}|[^\\]"'\`])*(?:\\]|$)`
/** An unquoted value. It never starts with a backslash, which belongs to an escaped quote that the JSON string pass
 * below has already masked, so masking it again would only hide the readable quote
 */
const bareValue = `(?!\\\\)[^\\s"'&,}]`
/** A URL value, such as a signed upload URL, hidden whole with its query string */
const urlValue = `https?:\\/\\/[^\\s"'<>,}]+`
/** An object value, such as password: { value: 'x' } in inspected text, hidden whole up to its closing brace with one
 * nested level. A deeper or unclosed object hides the rest of the line
 */
const objectValue = `\\{(?:[^{}\\n]|\\{[^{}\\n]*\\})*(?:\\}|[^\\n]*)`

/** The replacement for a labelled value: A quoted value keeps its quotes, and an array becomes [redacted]. An empty
 * quoted value holds no secret and stays readable, so a missing value does not look hidden
 */
const hiddenValue = (match: string, label: string, open?: string, close?: string) =>
    open === undefined
        ? `${label}${redacted}`
        : match === `${label}${open}${close}`
          ? match
          : `${label}${open}${redacted}${close}`
/** A bare value that cannot hold a secret, such as null in "password":null, which stays readable */
const absentWord = `(?:null|undefined|true|false)(?![^\\s"'&,}])`

// A key that labels a credential hides its value in an assignment such as FLUXER_BOT_TOKEN=, password= or api_key=, and
// after a quoted key such as "botToken": or "password":. A quoted value or an array is hidden whole, spaces and
// punctuation included. The lookbehind starts matches only at word starts, which keeps long words linear
const labelledAssignment = new RegExp(
    `(?<![A-Za-z0-9_])(${keyLabel}(?:["']\\s*(?:=>|[=:])|\\s*=)\\s*)(?:${quotedValue(2)}|${arrayValue(4)}|${objectValue}|${urlValue}|(?!${absentWord})${bareValue}+)`,
    "gi",
)
// After an unquoted key and a colon, such as password: 'x' in an inspected object, a quoted value, an array, an object or
// a URL is hidden whole
const labelledQuoted = new RegExp(
    `(?<![A-Za-z0-9_])(${keyLabel}\\s*:\\s*)(?:${quotedValue(2)}|${arrayValue(4)}|${objectValue}|${urlValue})`,
    "gi",
)
// After an unquoted key, a colon and an unquoted value, such as clientSecret:, only a credential-shaped value is hidden:
// 8 or more characters with a digit, or 20 or more. Prose such as "Missing token: check config" stays readable
const labelledColon = new RegExp(
    `(?<![A-Za-z0-9_])(${keyLabel}\\s*:\\s*)(?=[^\\s"'&,}]*\\d|[^\\s"'&,}]{20})${bareValue}{8,}`,
    "gi",
)
// Structure that follows the quote ending a string, such as a closing brace, the end or the next key or value
const stringEnd = `(?=\\s*(?:[}\\])]|$|,\\s*(?:["'\`\\[{]|[A-Za-z_$][\\w$-]*\\s*:)))`
// A quoted header value, which ends only at its own quote followed by such structure, because a cookie value can hold an
// unescaped quote of its own, as in "session="x"; theme=y" written into JSON by hand. Group 2 opens it and 3 closes it
const headerQuoted = `(["'\`])(?:\\\\.|(?!\\2${stringEnd})[^\\\\\\n])*(\\2|(?=\\n)|$)`
/**
 * The one header rule. A credential header hides its value in every form it is written or inspected in:
 * - A header line, such as Authorization: Basic x or Cookie: session="x"; theme=y
 * - A quoted value, as in an inspected object, a Headers object or JSON, hidden whole
 * - An array of values, as in Node's IncomingMessage headers or a JSON header map, hidden whole
 * - The value after a quoted name in a Map, rawHeaders or header pair list, such as 'Authorization' => or ["Cookie", "x"].
 *   After a comma, only a quoted value that is not itself a header name, so a list of names such as
 *   ["Authorization", "Content-Type"] and prose such as "Authorization", then a word stay readable
 * Names ignore case, - and _. A cookie list has no fixed shape and a cookie value can itself be quoted, so an unquoted
 * cookie list is hidden up to the end of the line or the quote that ends a string holding it. Another header hides its
 * scheme word, if any, and the value after it, whatever its length
 */
const header = (names: string, label: string, unquoted: string): HeaderRule[] => [
    {
        pattern: new RegExp(
            `(?<![A-Za-z0-9_-])((?:${names})(?:["']\\s*(?:=>|[:=])|${label})\\s*)(?:${headerQuoted}|${arrayValue(4)}|${unquoted})`,
            "gi",
        ),
        // An unquoted value that reads as prose, as in Cookie: not present, stays readable
        hide: (match, ...groups) => {
            const [label, open, close, array] = groups as [string, string?, string?, string?]
            const [offset, text] = groups.slice(-2) as [number, string]
            return open === undefined && array === undefined && headerProse(text.slice(offset + label.length))
                ? match
                : hiddenValue(match, label, open, close)
        },
    },
    {
        pattern: new RegExp(
            `(?<![A-Za-z0-9_-])((?:${names})["']\\s*,\\s*)(?!["'\`]${headerNameText}["'\`])${headerQuoted}`,
            "gi",
        ),
        // A quoted header name after it, as in a list of missing headers, stays readable. Inside a list whose key names
        // header names, such as missingHeaders: [ 'authorization', 'x-trace-id' ], a lowercase name does too
        hide: (match, ...groups) => {
            const [label, open, close] = groups as [string, string, string]
            const [offset, text] = groups.slice(-2) as [number, string]
            const value = match.slice(label.length + 1, match.length - close.length)
            return headerName(value) || (inHeaderNameList(text, offset) && listedHeaderName(value))
                ? match
                : hiddenValue(match, label, open, close)
        },
    },
]
/** A header rule and its replacement, which keeps a match that is a header name or prose */
interface HeaderRule {
    readonly pattern: RegExp
    readonly hide: (match: string, ...groups: unknown[]) => string
}
/** The names of a cookie assignment, such as cookies= or set_cookie= */
const cookieNames = "(?:set[-_]?)?cookies?"
/**
 * An unquoted cookie list after an assignment such as cookies= or set_cookie=: Fields joined by ;, or by a comma before
 * the next cookie as when a Set-Cookie array is joined into text. A field is a cookie such as sid=x or sid="x", or an
 * attribute such as Path=/ or HttpOnly. An Expires date holds spaces and a comma, so it runs to its GMT or to the next ;
 * instead. A quoted cookie value is kept whole when a field boundary follows its closing quote. Names and values use the
 * cookie alphabets, which hold &, ' } and a backtick, so these never end a field before more of the cookie. A quote or
 * } followed by a space, a comma or the end is the end of a string or object holding the list and stays readable, as do
 * a space and the prose after the last field. In a query, after ? or &, an & starts the next query field instead, so
 * ?cookie=x&state=y keeps its state readable. A Cookie: or Set-Cookie: header line is hidden up to the end of its line
 * instead
 */
const cookieList = (query: boolean) => {
    const ampersand = query ? "&" : ""
    // RFC 9110 token characters, which a cookie name is made of
    const name = `[A-Za-z0-9!#$%${query ? "" : "&"}'*+.^_\`|~-]+`
    const plain = `[^\\s"'\`,;}${ampersand}]`
    // A quote or }, kept in the field only when more of the cookie follows it
    const inner = `['\`}]+(?=[^\\s"'\`,;}\\])${ampersand}]|;\\s*${name}=)`
    const field = `(?:expires=(?:[^;\\r\\n"'&]*?GMT|[^;\\r\\n"'&]*)|${name}="[^"\\r\\n]*"(?![^\\s;,&}])|(?:${plain}|${inner})+)`
    return `${field}(?:(?:;|,(?=\\s*${name}=))\\s*${field})*;?`
}
const cookieAssignment = `(?:(?<=[?&]${cookieNames}=)${cookieList(true)}|(?<![?&]${cookieNames}=)${cookieList(false)})`
const credentialHeaders = [
    ...header(
        "(?:proxy[-_]?)?authorization|x[-_]?api[-_]?key",
        "\\s*[:=]",
        // A value the scheme rule already hid, such as Bearer [redacted], is hidden whole with its brackets
        `(?:(?:Bot|Bearer|Basic)\\s+)?(?:\\[redacted\\]|(?!\\\\)[^\\s"',}\\]]+)`,
    ),
    ...header(cookieNames, "\\s*:", `(?:(?!["'\`]${stringEnd})[^\\r\\n])+`),
    ...header(cookieNames, "\\s*=", cookieAssignment),
]

/** The signing parameters after ? or & in text, such as a URL or a query string, with the sig of an Azure SAS link and the
 * Signature of a Google V2 or CloudFront link
 */
const signingQuery = new RegExp(`([?&](?:${[...signingParameters, ...signatureKeys].join("|")})=)[^&\\s"'#]+`, "gi")
/** A signed JSON token, such as a JWT or a Fluxer upload relay token: Base64url JSON that starts with {", then one or two
 * dot-separated parts. Hidden whole wherever it appears, because its name, such as t, is too generic to mask by
 */
const signedToken = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g
/** An OAuth code that starts a form body, such as code=x&redirect_uri=y, hidden when a later field of the same body is
 * an OAuth field. A code after ? or & is hidden by the query rule
 */
const oauthFormCode =
    /(?<![^\s"'(])(code=)(?!\d{1,5}(?:[&\s"'#]|$))[^&\s"'#]+(?=[^\s"'#]*&(?:state|redirect_uri|code_verifier|grant_type)=)/g

// A standalone scheme word, in any letter case as HTTP allows, is masked only before a token-shaped value: 20 or more
// token characters including at least one digit or a mark other than a dot. Ordinary prose such as "Bot processSignals",
// "Basic validation" or "Bot application.commands.update" stays readable, while the header rule masks any value
const schemeToken = /\b(Bot|Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9_~+/=-])[A-Za-z0-9._~+/=-]{20,}/gi

/** How many escape levels deep the escaped text pass decodes. Each level needs at least twice the backslashes of the one
 * above it, so ordinary text never comes near it. A segment that still holds an escape at this depth is hidden whole
 */
const escapeDepth = 8
/** The characters that JSON and JavaScript string escapes such as \n stand for */
const escapes: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

/**
 * Mask escaped text, such as a quoted task name, a JSON body inside a JSON string or single-quoted JavaScript text. The
 * text rules read bare quotes, so without this a credential inside escaped quotes stays readable. The text is split at
 * each unescaped double quote and line break, so a stray quote cannot shift which characters are read as a string. Each
 * piece that holds a backslash is decoded leniently, masked with every rule, and encoded again only when masking
 * changed it, so a piece with nothing to mask is kept exactly as written. Decoding never fails, and a piece still
 * escaped at the depth limit is hidden, so no encoded credential is returned unread. Each level is one linear scan
 */
function maskEscapes(text: string, secrets: readonly string[], depth: number): string {
    if (!text.includes("\\")) return text
    let output = ""
    let start = 0
    const piece = (end: number) => {
        const segment = text.slice(start, end)
        output += segment.includes("\\") ? maskEscaped(segment, secrets, depth) : segment
    }
    for (let index = 0; index < text.length; index++) {
        const character = text[index]
        if (character === "\\") index++
        else if (character === '"' || character === "\n") {
            piece(index)
            output += character
            start = index + 1
        }
    }
    piece(text.length)
    return output
}

/** One escaped piece of text, decoded, masked and encoded again only when masking changed it */
function maskEscaped(segment: string, secrets: readonly string[], depth: number): string {
    const decoded = segment.replace(/\\(?:u([0-9a-fA-F]{4})|([^]))/g, (_match, hex?: string, character?: string) =>
        hex === undefined ? (escapes[character!] ?? character!) : String.fromCharCode(Number.parseInt(hex, 16)),
    )
    // Only a lone backslash at the end, which decodes to nothing shorter
    if (decoded.length >= segment.length) return segment
    if (depth >= escapeDepth) return redacted
    const masked = maskAt(decoded, secrets, depth + 1)
    if (masked === decoded) return segment
    const encoded = JSON.stringify(masked).slice(1, -1)
    return segment.includes("\\'") ? encoded.replaceAll("'", "\\'") : encoded
}

/** Replace credentials and invite codes in text: SDK-written text and the text of thrown values alike */
export function maskText(text: string, secrets: readonly string[] = []): string {
    return maskAt(text, secrets, 0)
}

/** The text rules. Without escapes, the escaped text pass is skipped, for inspection output whose strings were each
 * masked before inspection quoted them
 */
function maskAt(text: string, secrets: readonly string[], depth: number, escaped = true): string {
    let masked = text
    for (const secret of secrets) if (secret.length >= 6) masked = masked.split(secret).join(redacted)
    // JSON written into text, such as an error message that holds a response body, follows the same key policy as a
    // payload: A credential key hides its whole value, objects included, and an invite-shaped object hides its code
    masked = maskJsonKeys(masked)
    if (escaped) masked = maskEscapes(masked, secrets, depth)
    masked = masked.replace(schemeToken, `$1 ${redacted}`)
    for (const rule of credentialHeaders) masked = masked.replace(rule.pattern, rule.hide)
    return (
        masked
            .replace(labelledAssignment, hiddenValue)
            .replace(labelledQuoted, hiddenValue)
            .replace(labelledColon, `$1${redacted}`)
            // A bare Fluxer bot token is <application_id>.<secret>, whose secret is 32 random bytes in base64url.
            // The application ID stays readable, and snowflake pairs such as 123.456 never match
            .replace(/\b(\d{15,21})\.[A-Za-z0-9_-]{40,}/g, `$1.${redacted}`)
            // OAuth authorization codes travel in query strings, while ordinary code fields and short numeric codes such
            // as ?code=404 stay readable
            .replace(/([?&]code=)(?!\d{1,5}(?:[&\s"'#]|$))[^&\s"'#]+/g, `$1${redacted}`)
            .replace(oauthFormCode, `$1${redacted}`)
            // The signature of a signed link, also when no upload_url label names it
            .replace(signingQuery, `$1${redacted}`)
            .replace(signedToken, redacted)
            .replace(/(\/webhooks\/\d+\/)[^\s/?#"']+/g, `$1${redacted}`)
            // A URL's user information, such as user:password in https://user:password@host/path, is hidden whole because
            // a user name alone can be a credential. The scheme, host and path stay readable. The match cannot leave the
            // authority, so an @ in a path, query or fragment is kept, and the last @ in the authority ends the user information
            .replace(/(:\/\/)[^\s/?#"'<>\\]+@/g, `$1${redacted}@`)
            .replace(/((?:fluxer\.gg|\/invites?|\/invite)\/)[A-Za-z0-9-]+/gi, `$1${redacted}`)
    )
}
/** Audit log action types for invite creation, update and deletion, whose target ID and code changes are invite codes */
const inviteAuditActions = new Set([40, 41, 42])
/** Gateway dispatch types whose data carries an invite code, also when it has no other invite field */
const inviteDispatches = new Set(["INVITE_CREATE", "INVITE_DELETE"])
/** REST route templates whose request and response bodies carry an invite code in their code field, such as the vanity
 * code sent to set it
 */
const inviteCodeRoutes = new Set(["/guilds/:id/vanity-url"])
/** Audit change pair values in policy form, such as old_value or the SDK's oldValue, which hold a credential when the
 * pair's key is a credential key
 */
const changeValueKeys = new Set(["oldvalue", "newvalue"])

type PayloadRange = { readonly start: number; readonly end: number }
type PayloadObject = {
    readonly keys: Set<string>
    readonly codes: PayloadRange[]
    /** Values under sig or Signature, masked when the object is a signed link's query */
    readonly signatures: PayloadRange[]
    /** The key of an audit change pair, such as code or vanity_url_code */
    changeKey?: string
    readonly changeValues: PayloadRange[]
    /** Values of code change pairs in this object's changes, masked when it is an invite audit entry */
    readonly codeChanges: PayloadRange[]
    actionType?: number
    targetId?: PayloadRange
}

/** Add a closed object's invite and audit ranges to the masked ranges. The parent is the object that contains it, and
 * invite is true for an object known to be invite data
 */
function finishPayloadObject(
    object: PayloadObject,
    parent: PayloadObject | undefined,
    ranges: PayloadRange[],
    invite: boolean,
) {
    if (
        invite ||
        inviteShapeKeys.some((key) => object.keys.has(key)) ||
        (object.keys.has("channel") && object.keys.has("guild")) ||
        oauthShape(object.keys)
    )
        ranges.push(...object.codes)
    if (signedLinkShape(object.keys)) ranges.push(...object.signatures)
    if (object.changeKey !== undefined && sensitiveKey(object.changeKey)) ranges.push(...object.changeValues)
    else if (object.changeKey === "code") parent?.codeChanges.push(...object.changeValues)
    if (object.actionType !== undefined && inviteAuditActions.has(object.actionType)) {
        ranges.push(...object.codeChanges)
        if (object.targetId) ranges.push(object.targetId)
    }
}

/** Remember an audit entry's numeric action type, which decides whether its target ID and code changes are invite codes */
function noteActionType(object: PayloadObject | undefined, key: string, text: string, start: number) {
    const digits = policyKey(key) === "actiontype" ? /^\d+/.exec(text.slice(start, start + 8)) : null
    if (object && digits) object.actionType = Number(digits[0])
}

/** Remember a quoted value whose key can make it an invite code or a credential once its object closes */
function notePayloadValue(object: PayloadObject, key: string, text: string, range: PayloadRange) {
    if (key === "code") object.codes.push(range)
    else if (signatureKeys.has(policyKey(key))) object.signatures.push(range)
    else if (changeValueKeys.has(policyKey(key))) object.changeValues.push(range)
    else if (policyKey(key) === "targetid") object.targetId = range
    else if (key === "key")
        try {
            const quoted = text.slice(range.start, range.end)
            // Inspection writes the change key in single quotes, as in { key: 'code', newValue: 'x' }
            const value: unknown = /^'[^'\\]*'$/.test(quoted) ? quoted.slice(1, -1) : JSON.parse(quoted)
            if (typeof value === "string") object.changeKey = value
        } catch {
            // allow-silent: A cut off change key is not a change pair this masker recognizes
        }
}

/** Mask credential-key values and invite-shaped codes in text, every rule included. With inviteBody, the code of the
 * outermost object is an invite code
 */
function maskPayloadText(text: string, secrets: readonly string[], inviteBody = false): string {
    return maskAt(inviteBody ? maskJsonKeys(text, true) : text, secrets, 0)
}

/** Hide credential-key values and invite-shaped codes in JSON-like text, including a truncated value, keeping the quote
 * style of each hidden value. Keys are quoted, as in JSON, or written as inspection writes them: An identifier after {
 * or a comma inside braces, as in { hm: 'x' }, and a quoted Map key before =>, as in Map(1) { 'code' => 'x' }. Values
 * are read whole as inspection writes them too, in backticks for text with both quote kinds and as quoted fragments
 * joined by + for text with line breaks. With inviteBody, the code of the outermost object is an invite code
 */
function maskJsonKeys(text: string, inviteBody = false): string {
    if (!text.includes(":") && !text.includes("=>")) return text
    const keys = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<=[{,]\s*)[A-Za-z_$][\w$]*)(\s*(?::|=>)\s*)/g
    const ranges: PayloadRange[] = []
    const objects: PayloadObject[] = []
    // The object is removed from the stack first, so the top of the stack is the object that contains it
    const finish = (object: PayloadObject) =>
        finishPayloadObject(object, objects.at(-1), ranges, inviteBody && objects.length === 0)
    let scanned = 0
    let scanQuote: string | undefined
    // Track object boundaries outside strings so a nested diagnostic code does not become an invite code
    const scanObjects = (until: number) => {
        for (; scanned < until; scanned++) {
            const character = text[scanned]!
            if (scanQuote !== undefined) {
                if (character === "\\") scanned++
                else if (character === scanQuote) scanQuote = undefined
            } else if (character === '"' || character === "'" || character === "`") scanQuote = character
            else if (character === "{")
                objects.push({ keys: new Set(), codes: [], signatures: [], changeValues: [], codeChanges: [] })
            else if (character === "}" && objects.length > 0) finish(objects.pop()!)
        }
    }
    for (let match = keys.exec(text); match !== null; match = keys.exec(text)) {
        scanObjects(match.index)
        if (scanQuote !== undefined) continue
        const quoted = match[1]!
        const object = objects[objects.length - 1]
        const bare = quoted[0] !== '"' && quoted[0] !== "'"
        // An identifier key outside braces is prose, such as "Missing scope, token: check config", which the free-text
        // rules read. A bare key before => is not a Map key either
        if (bare && (object === undefined || match[2]!.includes("=>"))) continue
        let key: string
        try {
            key = bare ? quoted : quoted[0] === '"' ? (JSON.parse(quoted) as string) : quoted.slice(1, -1)
        } catch {
            // allow-silent: An invalid quoted key is not a credential key, so free-text masking still applies below
            continue
        }
        object?.keys.add(key)
        const start = keys.lastIndex
        const first = text[start]
        const sensitive = sensitiveKey(key)
        noteActionType(object, key, text, start)
        if (!sensitive && first !== '"' && first !== "'" && first !== "`") continue
        let end = start
        let quote: string | undefined
        let nesting = 0
        for (; end < text.length; end++) {
            const character = text[end]!
            if (quote !== undefined) {
                if (character === "\\") end++
                else if (character === quote) {
                    quote = undefined
                    if (nesting === 0) {
                        // Inspection writes a long string with line breaks, such as a PEM private key, as quoted
                        // fragments joined by +, which together are the value
                        const joined = /^\s*\+\s*(?=["'`])/.exec(text.slice(end + 1, end + 64))
                        if (joined) {
                            end += joined[0].length
                            continue
                        }
                        end++
                        break
                    }
                }
            } else if (character === '"' || character === "'" || character === "`") quote = character
            else if (character === "{" || character === "[") nesting++
            else if (character === "}" || character === "]") {
                if (nesting === 0) break
                if (--nesting === 0) {
                    end++
                    break
                }
            } else if (nesting === 0 && /[,\s]/.test(character)) break
        }
        end = Math.min(end, text.length)
        keys.lastIndex = end
        // A value that cannot hold a secret, such as null, "" or inspection's undefined and [Getter], stays readable
        if (
            sensitive &&
            !/^(?:null|undefined|true|false|""|''|\[(?:Getter|Setter|Getter\/Setter)\])$/.test(text.slice(start, end))
        )
            ranges.push({ start, end })
        else if (object) notePayloadValue(object, key, text, { start, end })
    }
    scanObjects(text.length)
    // A cut off text leaves objects open, which finish innermost first so a change pair reaches its audit entry
    while (objects.length > 0) finish(objects.pop()!)
    return hideRanges(text, ranges)
}

/** Replace each range with a hidden value in the quote style of the value it hides */
function hideRanges(text: string, ranges: PayloadRange[]): string {
    let output = ""
    let copied = 0
    for (const { start, end } of ranges.sort((left, right) => left.start - right.start)) {
        if (start < copied) continue
        output += text.slice(copied, start) + (text[start] === "'" ? `'${redacted}'` : JSON.stringify(redacted))
        copied = end
    }
    return output + text.slice(copied)
}

/** The guarded type tag of a value, such as [object Object]. Never throws */
function typeTag(value: unknown): string {
    try {
        return Object.prototype.toString.call(value)
    } catch {
        // allow-silent: A value that rejects every inspection is still named in the description
        return "[a value that cannot be described]"
    }
}

/** Inspection text for a masked copy, or the original's type tag when inspection throws. Never throws */
function inspected(copy: unknown, original: unknown): string {
    try {
        return inspect(copy, { depth: 2, breakLength: Infinity })
    } catch {
        // allow-silent: An uninspectable value falls back to its type tag in the same description
        return typeTag(original)
    }
}

/** The value of an own data property. An accessor is never called, and a proxy's get trap never runs */
function ownData(source: object, key: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** The value of a data property on an object or its prototype chain, such as an inherited name or inspection method.
 * An accessor is never called
 */
function chainData(source: object, key: PropertyKey): unknown {
    let current: object | null = source
    for (let steps = 0; current !== null && steps < 64; steps++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined
        current = Object.getPrototypeOf(current) as object | null
    }
    return undefined
}

/** The class name inspection shows for an object, read from data properties only, or undefined for a plain object */
function className(source: object): string | undefined {
    const prototype = Object.getPrototypeOf(source) as object | null
    if (prototype === null || prototype === Object.prototype) return undefined
    const constructor = ownData(prototype, "constructor")
    const name = typeof constructor === "function" ? ownData(constructor, "name") : undefined
    return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined
}

/** An empty object that inspection names like the original: Plain, null-prototype or named after its class */
function emptyLike(source: object): Record<string, unknown> {
    if (Object.getPrototypeOf(source) === null) return Object.create(null) as Record<string, unknown>
    const name = className(source)
    if (name === undefined) return {}
    const Named = { [name]: class {} }[name]!
    return new Named() as Record<string, unknown>
}

/** A stand-in that inspection prints as this text, without quotes */
const printed = (text: string) => ({ [inspect.custom]: () => text })

/** A property descriptor read as data, so its accessor functions are compared rather than called as methods */
type Descriptor = { readonly get?: unknown; readonly value?: unknown }

/** The engine's own stack accessor, shared by every Error. Calling it runs no application code */
const nativeStack = (Object.getOwnPropertyDescriptor(new Error("stack accessor"), "stack") as Descriptor | undefined)
    ?.get

/** An Error's stack text, read without calling an application getter */
function errorStack(error: object): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(error, "stack") as Descriptor | undefined
    if (descriptor === undefined) return undefined
    if ("value" in descriptor) return descriptor.value
    return typeof nativeStack === "function" && descriptor.get === nativeStack
        ? Reflect.apply(nativeStack, error, [])
        : undefined
}

/** Objects that inspection shows from internal state rather than keys, kept as they are: Dates, binary data and the like */
function internalState(item: object): boolean {
    return (
        types.isDate(item) ||
        types.isRegExp(item) ||
        types.isArrayBufferView(item) ||
        types.isAnyArrayBuffer(item) ||
        types.isWeakMap(item) ||
        types.isWeakSet(item) ||
        types.isNumberObject(item) ||
        types.isBooleanObject(item) ||
        types.isBigIntObject(item) ||
        types.isSymbolObject(item)
    )
}

/** The context of an object: Invite data of a dispatch, or a change pair of an invite audit entry */
type CopyContext = "invite" | "inviteChange" | "headerNames" | undefined

/** What an object's own fields say about how its keys are masked: Whether a code is an invite or authorization code,
 * whether it is an invite audit entry or a masked change pair, and whether it is an invite dispatch
 */
function keyFacts(source: object, keys: readonly string[], context: CopyContext) {
    // A code is an invite code in invite data, or an authorization code next to an OAuth field
    const codes =
        context === "invite" ||
        inviteShapeKeys.some((key) => key in source) ||
        ("channel" in source && "guild" in source) ||
        oauthShape(keys)
    const actionType = ownData(source, "action_type") ?? ownData(source, "actionType")
    const inviteAudit = typeof actionType === "number" && inviteAuditActions.has(actionType)
    const changeKey = ownData(source, "key")
    const maskedChange =
        typeof changeKey === "string" &&
        (sensitiveKey(changeKey) || (context === "inviteChange" && changeKey === "code"))
    const dispatch = ownData(source, "t")
    const inviteData = typeof dispatch === "string" && inviteDispatches.has(dispatch)
    return { codes, signed: signedLinkShape(keys), inviteAudit, maskedChange, inviteData }
}

/** Own keys of an Error that its masked copy writes itself rather than copying */
const errorOwnKeys = new Set(["stack", "message"])

/**
 * Copy a value with credential, header and invite-code values masked. Strings are masked as JSON-like text. For a
 * payload, the copy is JSON-ready. For inspection, the copy keeps Map, Set, class and null-prototype shapes and stops
 * below the depth inspection prints. Every property is read from its descriptor, so no getter or proxy get trap runs,
 * and accessors stay accessors that inspection prints as [Getter]. An Error becomes a masked Error copy with its own
 * properties, cause and errors masked the same way. An object with its own inspection method is shown by the masked
 * copy of what that method returns, and a function or promise by a short summary, so no original object reaches
 * inspection with readable contents. An object that rejects reading becomes its type tag, which keeps the rest of the
 * description. The route context marks the code of a vanity URL body as an invite code. A payload that rejects reading
 * throws
 */
function maskedCopy(value: unknown, secrets: readonly string[], json: boolean, inviteBody = false): unknown {
    // A payload is a tree, so a repeat is a cycle. Inspection tracks only the current path, so an object shown twice,
    // such as the same details under request and response, is shown both times
    const seen = new WeakSet<object>()
    type Context = CopyContext

    /** Copy own enumerable string keys with the key policy */
    const copyKeys = (source: object, copy: Record<string, unknown>, depth: number, context: Context) => {
        const keys = Object.keys(source)
        const { codes, signed, inviteAudit, maskedChange, inviteData } = keyFacts(source, keys, context)
        const error = !json && copy instanceof Error
        for (const key of keys) {
            if (error && errorOwnKeys.has(key)) continue
            let entry: unknown
            if (json) entry = (source as Record<string, unknown>)[key]
            else {
                const descriptor = Object.getOwnPropertyDescriptor(source, key)
                if (descriptor === undefined) continue
                if (!("value" in descriptor)) {
                    // Inspection prints [Getter] or [Setter] for an accessor without calling it, and so does the copy
                    Object.defineProperty(copy, key, {
                        ...(descriptor.get ? { get: () => undefined } : {}),
                        ...(descriptor.set ? { set: () => undefined } : {}),
                        enumerable: true,
                        configurable: true,
                    })
                    continue
                }
                entry = descriptor.value
            }
            copy[key] =
                hiddenEntry(key, entry) ||
                (typeof entry === "string" && companionCredential(key, codes, signed)) ||
                (policyKey(key) === "targetid" && inviteAudit) ||
                (maskedChange && changeValueKeys.has(policyKey(key)))
                    ? redacted
                    : visit(
                          entry,
                          depth + 1,
                          inviteAudit && key === "changes"
                              ? "inviteChange"
                              : inviteData && key === "d"
                                ? "invite"
                                : headerNameListKey(key)
                                  ? "headerNames"
                                  : undefined,
                      )
        }
    }

    /** A masked Error copy with the original's class name, message, stack, own properties, cause and errors */
    const copyError = (item: object, depth: number): Error => {
        const name = chainData(item, "name")
        const message = chainData(item, "message")
        const nameText = typeof name === "string" ? name : (className(item) ?? "Error")
        const messageText = typeof message === "string" ? message : ""
        const stack = errorStack(item)
        const Named = { [nameText]: class extends Error {} }[nameText]!
        const copy = new Named(maskText(messageText, secrets))
        copy.stack = maskText(typeof stack === "string" ? stack : `${nameText}: ${messageText}`, secrets)
        copyKeys(item, copy as unknown as Record<string, unknown>, depth, undefined)
        // Inspection prints a non-enumerable cause and AggregateError errors as [cause] and [errors]
        for (const key of ["cause", "errors"]) {
            const descriptor = Object.getOwnPropertyDescriptor(item, key)
            if (descriptor !== undefined && "value" in descriptor && !descriptor.enumerable)
                Object.defineProperty(copy, key, {
                    value: visit(descriptor.value, depth + 1),
                    enumerable: false,
                    configurable: true,
                    writable: true,
                })
        }
        return copy
    }

    /** A masked array copy. Inspection prints at most 100 entries, and so does the copy */
    const copyArray = (item: unknown[], depth: number, context: Context): unknown[] => {
        const length = json ? item.length : ownData(item, "length")
        const total = typeof length === "number" ? length : 0
        const shown = json ? total : Math.min(total, 100)
        const entries: unknown[] = []
        const copy: unknown[] = []
        for (let index = 0; index < shown; index++) {
            if (json) entries[index] = item[index]
            else {
                const descriptor = Object.getOwnPropertyDescriptor(item, index)
                if (descriptor === undefined) {
                    copy.length = index + 1
                    continue
                }
                if (!("value" in descriptor)) {
                    copy[index] = printed(descriptor.set ? "[Getter/Setter]" : "[Getter]")
                    continue
                }
                entries[index] = descriptor.value
            }
            copy[index] = visit(entries[index], depth + 1, context)
        }
        if (shown < total) copy.push(printed(`... ${total - shown} more items`))
        // A header pair list or rawHeaders array holds names at even indexes, so a credential header name there hides
        // the entry after it, unless that entry is itself a header name, as in a list of header names. Under a key that
        // names a list of header names, such as missingHeaders, a lowercase name such as x-trace-id also counts
        const isName = context === "headerNames" ? listedHeaderName : headerName
        for (let index = 0; index + 1 < entries.length; index += 2) {
            const name = entries[index]
            const next = entries[index + 1]
            if (
                typeof name === "string" &&
                headerKeys.has(policyKey(name)) &&
                !absent(next) &&
                !(typeof next === "string" && isName(next))
            )
                copy[index + 1] = redacted
        }
        hideEntryValues(entries, copy)
        return copy
    }

    /** A list of [name, value] entries, as Object.entries writes them, hides the value of each credential name and the
     * code of an invite-shaped list, as its object would. A lone pair of names such as ["password", "username"] is a
     * list of names and stays readable
     */
    const hideEntryValues = (entries: readonly unknown[], copies: readonly unknown[]) => {
        if (entries.length === 0 || !entries.every((entry) => Array.isArray(entry) && ownData(entry, "length") === 2))
            return
        const names = new Set(entries.map((entry) => ownData(entry as unknown[], 0)))
        const invite =
            inviteShapeKeys.some((key) => names.has(key)) ||
            (names.has("channel") && names.has("guild")) ||
            oauthShape(names)
        const signed = signedLinkShape(names)
        for (const [index, entry] of entries.entries()) {
            const name = ownData(entry as unknown[], 0)
            const target = copies[index]
            if (
                typeof name === "string" &&
                (hiddenEntry(name, ownData(entry as unknown[], 1)) || companionCredential(name, invite, signed)) &&
                Array.isArray(target)
            )
                target[1] = redacted
        }
    }

    const copyObject = (item: object, depth: number, context: Context, custom: boolean): unknown => {
        if (Array.isArray(item)) return copyArray(item, depth, context)
        if (json) {
            const copy: Record<string, unknown> = {}
            copyKeys(item, copy, depth, context)
            return copy
        }
        if (typeof item === "function") {
            const name = ownData(item, "name")
            return printed(`[Function: ${typeof name === "string" && name !== "" ? name : "(anonymous)"}]`)
        }
        if (types.isPromise(item)) return printed("Promise { <not shown> }")
        if (types.isStringObject(item))
            return printed(`[String: ${inspect(maskText(String.prototype.valueOf.call(item), secrets))}]`)
        // Inspection of a URL also prints its searchParams, which no text rule reads, so it is shown as its masked text
        if (item instanceof URL) return printed(`URL ${inspect(maskText(item.href, secrets))}`)
        // A parsed query, such as a URL's searchParams, is masked as the query text it came from, so an OAuth code stays
        // hidden and other parameters such as state stay readable
        if (item instanceof URLSearchParams)
            return printed(
                inspect(new URLSearchParams(maskText(`?${URLSearchParams.prototype.toString.call(item)}`, secrets))),
            )
        if (internalState(item)) return item
        const method = custom ? chainData(item, inspect.custom) : undefined
        if (typeof method === "function") {
            // The object's own inspection runs as inspection would run it, and what it returns is masked like any value
            const shown: unknown = (method as (...args: unknown[]) => unknown).call(
                item,
                2 - depth,
                { ...inspect.defaultOptions, depth: 2 - depth, breakLength: Infinity, stylize: (text: string) => text },
                (inner: unknown) => maskValue(inner, secrets),
            )
            if (typeof shown === "string") return printed(maskText(shown, secrets))
            return visitObject(shown, depth, context, false)
        }
        if (types.isNativeError(item) || item instanceof Error) return copyError(item, depth)
        if (types.isMap(item)) {
            const entries = [...(Map.prototype.entries.call(item) as MapIterator<[unknown, unknown]>)]
            const keys = new Set(entries.map(([key]) => key))
            const invite =
                inviteShapeKeys.some((key) => keys.has(key)) ||
                (keys.has("channel") && keys.has("guild")) ||
                oauthShape(keys)
            const signed = signedLinkShape(keys)
            const copy = new Map<unknown, unknown>()
            for (const [key, entry] of entries)
                copy.set(
                    visit(key, depth + 1),
                    typeof key === "string" && (hiddenEntry(key, entry) || companionCredential(key, invite, signed))
                        ? redacted
                        : visit(entry, depth + 1),
                )
            return copy
        }
        if (types.isSet(item)) {
            const entries = [...(Set.prototype.values.call(item) as SetIterator<unknown>)]
            const copies = entries.map((entry) => visit(entry, depth + 1))
            hideEntryValues(entries, copies)
            return new Set(copies)
        }
        const copy = emptyLike(item)
        copyKeys(item, copy, depth, context)
        return copy
    }

    const visitObject = (item: unknown, depth: number, context: Context, custom: boolean): unknown => {
        if ((typeof item !== "object" && typeof item !== "function") || item === null)
            return visit(item, depth, context)
        if (json) {
            if (seen.has(item) || depth > 32) return "[circular]"
            seen.add(item)
            return copyObject(item, depth, context, custom)
        }
        try {
            // Inspection shows deeper objects only by their class name
            if (depth > 2) return printed(`[${Array.isArray(item) ? "Array" : (className(item) ?? "Object")}]`)
            if (seen.has(item)) return printed("[Circular]")
            seen.add(item)
            try {
                return copyObject(item, depth, context, custom)
            } finally {
                seen.delete(item)
            }
        } catch {
            // allow-silent: An object that rejects reading, such as a hostile proxy, is named by its type tag in place
            return printed(typeTag(item))
        }
    }

    const visit = (item: unknown, depth: number, context?: Context): unknown => {
        // Only a body that is itself text, such as a cut off response, is the vanity body
        if (typeof item === "string") return maskPayloadText(item, secrets, inviteBody && depth === 0)
        if (typeof item === "bigint") return json ? item.toString() : item
        if (typeof item === "function" && !json) return visitObject(item, depth, context, true)
        if (typeof item !== "object" || item === null) return item
        return visitObject(item, depth, context, true)
    }
    return visit(value, 0, inviteBody ? "invite" : undefined)
}

/** Copy a payload with credential, secret and invite-code values masked, then render it as bounded JSON. The route is
 * the REST route template of a request or response body, which marks the code of a vanity URL body as an invite code
 */
export function maskPayload(value: unknown, secrets: readonly string[] = [], limit = 65_536, route?: string): string {
    const inviteBody = route !== undefined && inviteCodeRoutes.has(route)
    let text: string
    try {
        text = JSON.stringify(maskedCopy(value, secrets, true, inviteBody)) ?? maskValue(value, secrets)
    } catch {
        // allow-silent: An unserializable payload is replaced by its guarded masked description in the same record
        text = maskValue(value, secrets)
    }
    return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text
}

/**
 * Masked text for any thrown or logged value that the SDK did not write. A string is masked as text. Another value is
 * first copied with the structural rules, so values under credential keys, in header pairs and in Map entries are hidden
 * before inspection turns it into text, also inside Errors, proxies and objects with their own inspection, and the text
 * rules then run over that text. No getter runs. Never throws, including for null-prototype objects, hostile proxies
 * and getters, symbols and bigints: An object whose properties reject reading is named by its type tag
 */
export function maskValue(value: unknown, secrets: readonly string[] = []): string {
    if (typeof value === "string") return maskText(value, secrets)
    let copy: unknown
    try {
        copy = maskedCopy(value, secrets, false)
    } catch {
        // allow-silent: A value whose properties reject reading cannot be checked key by key, so only its type tag is shown
        return maskText(typeTag(value), secrets)
    }
    // Every string in the copy was masked before inspection quoted it, so the escaped text pass would only reread them
    return maskAt(inspected(copy, value), secrets, 0, false)
}

/** The masked code of an application Error, such as ECONNRESET. An Error shaped like an invite, with own invite fields
 * such as max_uses, or like an OAuth callback, with own fields such as state, holds an invite or authorization code
 * there, which is hidden. Never throws
 */
export function maskedErrorCode(error: object, code: string, secrets: readonly string[] = []): string {
    try {
        if (inviteShapeKeys.some((key) => Object.prototype.hasOwnProperty.call(error, key))) return redacted
        // An Error that also carries an OAuth field, such as state, holds an authorization code
        if (oauthShape(Object.keys(error))) return redacted
    } catch {
        // allow-silent: An Error that rejects reading its keys keeps only its masked code text
    }
    return maskText(code, secrets)
}

/** Masked one-line "Name: message" text for an Error, or the masked description of another value. Never throws */
export function maskedSummary(value: unknown, secrets: readonly string[] = []): string {
    try {
        if (value instanceof Error) return maskText(`${String(value.name)}: ${String(value.message)}`, secrets)
    } catch {
        // allow-silent: An Error whose name or message getters throw is described by the guarded fallback below
    }
    return maskValue(value, secrets)
}

/** The masked message of an Error, or the masked description of another value. Never throws */
export function maskedMessage(value: unknown, secrets: readonly string[] = []): string {
    try {
        if (value instanceof Error) return maskText(String(value.message), secrets)
    } catch {
        // allow-silent: An Error whose message getter throws is described by the guarded fallback below
    }
    return maskValue(value, secrets)
}
