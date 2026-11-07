/**
 * FR-R3-048 — the armor labels that denote a PRIVATE key, in one place.
 *
 * `AGENTS.md` names this file as the redaction set's home and forbids forking it.
 * Stateful line redaction needs the same knowledge (which labels open a key
 * block), so the list is exported and both consumers derive from it: the
 * whole-string pattern in `SECRET_PATTERNS` below, and `KeyBlockLineRedactor`.
 * Writing the list twice is how a pattern and a detector drift until one quietly
 * stops covering a label.
 *
 * `PUBLIC KEY` is deliberately absent. Public keys are meant to be shareable and
 * a test pins that they pass through byte-identical.
 *
 * The list holds ALGORITHM labels only. The unlabeled PKCS#8 spelling -- a BEGIN
 * header whose label is just `PRIVATE KEY` -- is covered by making the label
 * optional in `ARMOR_LABEL_ALTERNATION` below rather than by an entry here,
 * because it is the absence of a label rather than another one.
 *
 * Armor headers are DESCRIBED in these comments, never spelled out complete:
 * `scripts/scan-secrets.mjs` matches the literal header and has no allowlist, so
 * a comment that spells one turns this file into a finding on a security gate.
 */
export const PRIVATE_KEY_ARMOR_LABELS: ReadonlyArray<string> = Object.freeze([
  'RSA',
  'DSA',
  'EC',
  'OPENSSH',
  'PGP',
  'ENCRYPTED'
]);

/**
 * `[<LABEL> ]PRIVATE KEY` with an OPTIONAL ` BLOCK` suffix.
 *
 * The ` BLOCK` suffix is optional, not required: GnuPG writes
 * `PGP PRIVATE KEY BLOCK`, while the older `PGP PRIVATE KEY` spelling is what
 * the pre-change pattern matched -- and the hard rule forbids weakening, so both
 * must match.
 *
 * The LABEL is optional too, and that is the point of the group being wrapped in
 * `(?: )?`. PKCS#8 -- what `openssl genpkey`, `openssl pkcs8` and
 * `ssh-keygen -m PKCS8` all write, and the default private-key encoding of most
 * current tooling -- carries no algorithm label at all; its BEGIN header reads
 * just `PRIVATE KEY` between the dash runs. A label-required alternation misses
 * it entirely, so a complete PKCS#8 key printed to stdout passed through both
 * sinks untouched; only the `"private_key":` JSON envelope pattern caught it, and
 * only inside that envelope. `PUBLIC KEY` still cannot match: the literal here is
 * `PRIVATE KEY`.
 */
const ARMOR_LABEL_ALTERNATION =
  `(?:(?:${PRIVATE_KEY_ARMOR_LABELS.join('|')}) )?PRIVATE KEY(?: BLOCK)?`;

/** A complete block: BEGIN through the next END. Non-greedy and bounded to 64 KiB so a 16 MiB unterminated body cannot overflow V8's RegExp backtrack stack. */
const PRIVATE_KEY_BLOCK_RE = new RegExp(
  `-----BEGIN ${ARMOR_LABEL_ALTERNATION}-----[\\s\\S]{0,65536}?-----END ${ARMOR_LABEL_ALTERNATION}-----`,
  'g'
);

/** An unterminated block: BEGIN through end of input. */
const PRIVATE_KEY_UNTERMINATED_RE = new RegExp(
  `-----BEGIN ${ARMOR_LABEL_ALTERNATION}-----[\\s\\S]*$`,
  'g'
);

/**
 * The two private-key alternatives on their own, so `sanitize()` can apply them
 * BEFORE the general union rather than as members of it.
 *
 * Membership alone is not enough, and this was measured. Alternation is
 * LEFTMOST-match: whichever alternative starts earliest in the input wins,
 * regardless of its position in `SECRET_PATTERNS`. The env-style
 * `KEY=VALUE` entry accepts `-` in its value class, so on
 *
 *     SECRET_KEY=<a BEGIN header>\n<body>\n<END footer>
 *
 * it matches from index 0 and consumes the header's leading dash run and the
 * word after it. Nothing that looks like a BEGIN marker is left, so neither
 * key-block alternative ever fires and the entire body and footer survive --
 * the exact H-07 outcome, reached by a different route. The `sk-…` entry does
 * the same thing for the same reason (its body class also accepts `-`).
 *
 * Running the key-block pass first removes the block before any other pattern
 * can claim a byte of it. The two entries stay in `SECRET_PATTERNS` as well:
 * they are then unreachable but harmless, and the single-source guard counts
 * their derivations.
 */
const PRIVATE_KEY_ANY_RE = new RegExp(
  `(?:${PRIVATE_KEY_BLOCK_RE.source})|(?:${PRIVATE_KEY_UNTERMINATED_RE.source})`,
  'g'
);

/**
 * Cheap prefilter for the pass above: every match of `PRIVATE_KEY_ANY_RE` must
 * contain this literal, so a line without it cannot match and does not need the
 * regex. One substring scan rather than a third full regex pass, which is what
 * FR-022 asks of the transport hot path.
 */
const PRIVATE_KEY_MARKER_PREFIX = '-----BEGIN ';

/** Framing detectors for the line-oriented path. Same labels, no redaction here. */
const PRIVATE_KEY_BEGIN_RE = new RegExp(`-----BEGIN ${ARMOR_LABEL_ALTERNATION}-----`);
const PRIVATE_KEY_END_RE = new RegExp(`-----END ${ARMOR_LABEL_ALTERNATION}-----`);

/**
 * The BEGIN detector again, global, so the LAST marker on a line can be located
 * rather than merely detected.
 *
 * Built from `PRIVATE_KEY_BEGIN_RE.source` rather than by interpolating the
 * alternation a sixth time: one derivation per private-key regex is what the
 * single-source guard counts, and this is the same regex with another flag, not
 * another spelling of the label set. Only ever used through `matchAll`, which
 * species-constructs its own clone, so this object's `lastIndex` is never
 * mutated and the constant stays safe to share.
 */
const PRIVATE_KEY_BEGIN_GLOBAL_RE = new RegExp(PRIVATE_KEY_BEGIN_RE.source, 'g');
const PRIVATE_KEY_END_GLOBAL_RE = new RegExp(PRIVATE_KEY_END_RE.source, 'g');

/**
 * Index just past the LAST match of `pattern` in `line`, or -1 when it does not
 * match at all. Used to compare marker POSITIONS rather than mere presence.
 *
 * `matchAll` species-constructs its own clone of the regex, so the shared global
 * constants above never have their `lastIndex` mutated and stay safe to reuse.
 */
function lastMarkerEnd(pattern: RegExp, line: string): number {
  let end = -1;
  for (const match of line.matchAll(pattern)) {
    end = match.index + match[0].length;
  }
  return end;
}

/**
 * What every redaction in this module writes in place of a secret.
 *
 * One spelling, for the same reason the armor labels have one: `sanitize()`
 * writes it for the whole-string path and `KeyBlockLineRedactor` writes it for
 * the line-oriented one, and a sentinel that differs between the two makes a log
 * consumer grepping for one find only half the redactions.
 */
export const REDACTION_SENTINEL = '[REDACTED]';

/**
 * FR-R4-F10 (RD1; research R9, R10) -- the words that make a key name a secret key, in one place.
 *
 * Two things need to know which names denote a secret, and they must agree. The string pattern
 * below removes the VALUE after such a name in text (`password=...`, `"client_secret": "..."`), and
 * `isSecretKeyName` answers the same question for the structured walkers, which see a record's keys
 * and its leaves separately and so cannot use a text pattern. Writing the words twice is how the two
 * drift until one quietly stops covering a name, so both derive from this list, and
 * `tests/lint/redaction-key-names-single-source.test.ts` fails a second copy anywhere else.
 *
 * `secret` covers `client_secret`. The match is on the END of a name, so `input_tokens`,
 * `tokenizer` and `secretary` are not secret keys.
 */
export const SECRET_KEY_NAME_WORDS: ReadonlyArray<string> = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token'
]);

/**
 * Words that count only as the END of a longer name. `pwd` is the shell's working directory as well as
 * an abbreviation of a password: `PWD=/tmp/work` and `OLDPWD=/tmp/prev` are paths, which are not
 * secrets (FR-023), while `db_pwd` is one. The string pattern cannot tell `dbPwd` from `OLDPWD`
 * without case, so it asks for a separator before the word, and the structured predicate asks for a
 * name of more than one segment.
 */
const SUFFIX_ONLY_KEY_WORDS: ReadonlyArray<string> = Object.freeze(['pwd']);

/** The two-segment name that is a secret key although neither word alone would be checked as one. */
const CLIENT_SECRET_KEY = 'client_secret';

/**
 * FR-R5-F14 (NS-09) — qualifier words before `key` (`*_key` / `*_KEY` / `*Key`) that denote a
 * credential (`AWS_SECRET_ACCESS_KEY`, `aws_secret_access_key`, `MY_ACCESS_KEY`, `PRIVATE_KEY`,
 * `SIGNING_KEY`, `api_key`, etc.) without treating ordinary identifier fields (`primaryKey`,
 * `sortKey`, `cacheKey`, bare `key`) as secrets.
 */
const QUALIFIED_SECRET_KEY_PREFIXES: ReadonlyArray<string> = Object.freeze([
  'access',
  'api',
  'auth',
  'client',
  'encryption',
  'hmac',
  'master',
  'private',
  'secret',
  'service',
  'session',
  'signing',
  'webhook'
]);

/** Session-cookie key names recognized in structured records (`sanitizeRecord`). */
const SESSION_COOKIE_KEY_NAMES: ReadonlyArray<string> = Object.freeze([
  'session_id',
  'sessionid',
  'connect_sid',
  'jsessionid',
  'phpsessid'
]);

/**
 * True when `key` names a secret: split on camelCase and on `-`, `.`, space and `_`, lowercased, its
 * last segment (or its last two joined by `_`) is one of `SECRET_KEY_NAME_WORDS`, `client_secret`,
 * a qualified `*_key` credential name, or a session-cookie identifier.
 * `pwd` counts only when it is not the whole name. The structured walkers use it to remove a string
 * leaf whose own key names a secret, which the string patterns cannot see.
 *
 * Linear in the key's length: a key can come from model output (a tool call's argument names, up to the
 * phase log's 64 Ki field cap). The acronym split looks one character ahead instead of matching the whole
 * uppercase run, which backtracked over the run from every start and took 9 s for an 80 Ki-unit key.
 *
 * @param key a record key
 */
export function isSecretKeyName(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_')
    .toLowerCase()
    .split(/[-._\s]+/)
    .filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (SECRET_KEY_NAME_WORDS.includes(last)) {
    return !(SUFFIX_ONLY_KEY_WORDS.includes(last) && segments.length === 1);
  }
  const prev = segments.at(-2);
  if (last === 'key' && prev !== undefined && QUALIFIED_SECRET_KEY_PREFIXES.includes(prev)) {
    return true;
  }
  const tailPair = segments.slice(-2).join('_');
  return (
    tailPair === CLIENT_SECRET_KEY ||
    SESSION_COOKIE_KEY_NAMES.includes(tailPair) ||
    SESSION_COOKIE_KEY_NAMES.includes(last)
  );
}

/**
 * Value-only pattern for a keyed secret in text: the match is the VALUE, so replacing it with the
 * sentinel leaves the key readable (`MY_DB_PASSWORD=[REDACTED]`). The key word, an optional quote, up to
 * 8 spaces, `:` or `=`, up to 8 spaces and an optional quote sit in a bounded lookbehind. A backslash
 * before a quote is allowed, because a JSON document inside a JSON string spells its quotes `\"`.
 *
 * The value is at least 8 characters that are not whitespace, a quote, a backtick, `,`, `;` or `&`,
 * so `password: none` stays readable; a shorter keyed value in text is not removed (FR-022). The word
 * must abut its separator, so `tokens=` never matches `token`. No duplicate named groups: the module
 * must parse on Node 22 (research R9).
 *
 * FR-R5-F14 (NS-08): the trailing quote-escape backslash check runs in `replaceUnionMatch` in O(1)
 * rather than via a trailing regex lookahead `(?!(?<=\\)["'])`, which caused V8's Irregexp engine to
 * push one backtrack frame per character and throw `RangeError` on 6-16 MiB values.
 */
const KEYED_SECRET_VALUE_RE = new RegExp(
  `(?<=(?:${SECRET_KEY_NAME_WORDS.filter((word) => !SUFFIX_ONLY_KEY_WORDS.includes(word)).join('|')}` +
    `${SUFFIX_ONLY_KEY_WORDS.map((word) => `|(?<=[_.-])${word}`).join('')}` +
    `|(?:${QUALIFIED_SECRET_KEY_PREFIXES.join('|')})[_.-]?key` +
    `|${SESSION_COOKIE_KEY_NAMES.map((name) => name.replace('_', '[_.-]?')).join('|')})` +
    `\\\\?["']?[ \\t]{0,8}[:=][ \\t]{0,8}\\\\?["']?)[^\\s"'\`,;&]{8,}`,
  'gi'
);

/**
 * Value-only pattern for the password in URL userinfo (`scheme://user:PASSWORD@host`): the scheme and
 * username sit in a bounded lookbehind, so the scheme, user and host stay readable. The value ends at
 * the LAST `@` of the authority, which is the delimiter a URL parser uses, so an `@` inside a password
 * is removed with it. Userinfo with no colon (`ssh://git@host`) cannot match (research R11).
 */
const URL_USERINFO_PASSWORD_RE =
  /(?<=[a-z][a-z0-9+.-]{0,31}:\/\/[^:/?#@\s"']{0,128}:)[^/?#\s"'<>]{1,256}(?=@)/gi;

/**
 * What the markers on one line do to the block state: a line can open a block,
 * close one, or say nothing about either.
 */
type MarkerTransition = 'opened' | 'closed' | 'none';

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic / OpenAI style API keys. Word-boundary prefix prevents
  // matching `sk-` inside an unrelated word (e.g. `worksk-XYZ`); the
  // `(ant-|proj-|svcacct-)?` group covers both the Anthropic
  // (`sk-ant-…`) and OpenAI (`sk-proj-…`, `sk-svcacct-…`, legacy
  // `sk-…`) families.
  /\bsk-(ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens: personal access (`ghp_`), OAuth (`gho_`), user-to-server (`ghu_`),
  // server-to-server (`ghs_`) and refresh (`ghr_`), and fine-grained personal access tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // npm automation and publish tokens (`npm_` and 36 alphanumerics)
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Slack bot/user/app/refresh/legacy and xapp- app-level tokens
  /\b(?:xox[baprs]|xapp)-[A-Za-z0-9-]{10,}\b/g,
  // GitLab personal access tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // Hugging Face access tokens
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // AWS access key IDs (long-lived IAM user credentials)
  /\bAKIA[0-9A-Z]{16}\b/g,
  // AWS temporary session access key IDs (STS / assumed-role). Same
  // 20-char shape as AKIA but the `ASIA` prefix is the documented
  // distinguisher; treat with the same redaction urgency since the
  // accompanying session token grants identical privileges for its
  // lifetime.
  /\bASIA[0-9A-Z]{16}\b/g,
  // Google Cloud API key (developer key surface — 39 chars, `AIza`
  // prefix + 35-char body). Common dual-use leak in CI logs and
  // sample payloads.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  // Google OAuth 2.0 short-lived access token (ya29.…). Length is
  // implementation-defined but consistently > 40 chars in practice.
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  // Stripe live/test secret + restricted keys.
  /\b[rs]k_(live|test)_[A-Za-z0-9]{20,}\b/g,
  // GCP service account snippet.
  //
  // FR-R4-F10 (RD5; research R13): linear in the input. The old body, `[\s\S]+?`, could cross any number
  // of quotes, so an opening with no close made every later opening scan to the end of the input
  // (1.85 s at 1 MiB, quadratic). The body is now one JSON string: any character but a quote or a
  // backslash, or an escape. A raw quote cannot occur inside a JSON string, so only a cross-field match
  // the old expression over-redacted is given up, and the private-key pass above still removes any
  // armored block inside it. The armor labels are bounded as well, and so is the body (64 Ki units, many
  // times the size of any key): a lazy loop keeps one backtrack frame per character, and an unbounded one
  // threw "Maximum call stack size exceeded" on a 16 MiB body.
  /"private_key"\s*:\s*"-----BEGIN [A-Za-z0-9 ]{1,40}-----[^"]{0,65536}?-----END [A-Za-z0-9 ]{1,40}-----(?:\\n)?"/g,
  // Standalone PEM private-key blocks — SSH, PGP and the rest, leaking into
  // stdout without the JSON envelope above.
  //
  // FR-R3-048 (H-07). This used to match the HEADER ONLY, under the rationale
  // that "the header alone is enough to redact; the body is not required to
  // match because the header is the high-signal indicator". That is true of
  // DETECTING a secret and false of REMOVING one, and nothing tested the
  // difference: measured, a complete OpenSSH or RSA key lost its first line and
  // kept its entire base64 body and its END footer. Worse, the standard armor
  // GnuPG writes -- `PGP PRIVATE KEY BLOCK` -- did not match at all, so an
  // exported GPG private key passed through untouched, header included.
  //
  // Two ordered alternatives, both built from PRIVATE_KEY_ARMOR_LABELS so this
  // pattern and the line-oriented detector below cannot drift:
  //   1. a complete block, non-greedy, so two adjacent blocks are two matches
  //      and neither footer closes the other;
  //   2. an unterminated block, through end of input.
  // Order matters: bounded first, or a complete block would swallow the text
  // after it. The second alternative is deliberate over-redaction -- text after
  // an unterminated private-key header is lost, because a truncated key is
  // still a key.
  PRIVATE_KEY_BLOCK_RE,
  PRIVATE_KEY_UNTERMINATED_RE,
  // Bearer / Basic / Authorization / Proxy-Authorization headers
  /Bearer\s+[A-Za-z0-9_\-.+/=]{16,}/gi,
  /(?<=\b(?:Proxy-)?Authorization["'\s:=]+)(?:(?:Basic|Bearer|Digest|Token)\s+[A-Za-z0-9+/=._~-]{8,}|[A-Za-z0-9_\-.+/=]{16,})/gi,
  /authorization["'\s:=]+[A-Za-z0-9_\-.=]{16,}/gi,
  // Cookie and Set-Cookie session values
  /(?<=\b(?:[A-Za-z0-9_.-]*?(?:sess(?:ion)?(?:[_-]?id)?|connect\.sid|jsessionid|phpsessid)|(?<=\b(?:Set-)?Cookie[^\r\n]{0,256}?\b)sid)\s*=\s*)[^\s;,"']{8,}/gi,
  // api_key / apikey / api-key
  /api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
  // X-API-Key / X_API_KEY header style — common AWS API Gateway and
  // third-party SaaS shape that the api_key pattern misses because of
  // the `x-` prefix.
  /x[_-]api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
  // JSON Web Tokens.
  //
  // FR-R4-F10 (RD5; research R13): linear in the input, and safe on a 16 MiB run. The old expression
  // started at EVERY `eyJ`, and from each it scanned to the end of its run of token characters looking
  // for a `.`, so a line of repeated `eyJ` cost time quadratic in its length (10.8 s for 128 Ki).
  //
  // A match now starts only at the beginning of a run (the lookbehind). One lookahead asks whether the
  // run contains an `eyJ` with at least 8 token characters after it, which is what the old header part
  // asked; the header is then the whole run, followed by the same two segments. If the first `eyJ` of a
  // run cannot start a match, no later one in the same run can, since they share the run's end and the
  // same later segments, so one attempt per run decides it. The only change in output is a superset:
  // characters glued before the token (`abc` in `abceyJ...`) are removed with it.
  //
  // Every loop here is a greedy repeat of a single character class, which the regular-expression engine
  // runs without a backtrack frame per character. A lazy prefix (`[...]*?eyJ`) was tried first and
  // linear at 1 MiB, but it threw "Maximum call stack size exceeded" on one 16 MiB run.
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Generic KEY=VALUE secrets in env-style strings
  /\b(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z_]*\s*=\s*[A-Za-z0-9_\-/+=]{8,}/g,
  // FR-R4-F10 -- value-only matches that keep the key, scheme, user and host readable. Both are
  // case-insensitive, so they join the second union, which runs after the env-style rule above: that
  // rule consumes `PASSWORD=...` whole, and these then see no separator before the sentinel.
  KEYED_SECRET_VALUE_RE,
  URL_USERINFO_PASSWORD_RE
];

/**
 * Pre-compiled union regexes for the hot path. `sanitize()` formerly
 * iterated every pattern per call (one regex pass each per log line);
 * with two unions (case-sensitive and case-insensitive) the same
 * coverage costs 2 passes. Behavior is byte-identical: alternation
 * preserves leftmost-match semantics and every secret substring still
 * collapses to `[REDACTED]`.
 *
 * Build at module-init time. `SECRET_PATTERNS` stays the single source
 * of truth — adding a pattern to the array automatically extends the
 * matching union (no second edit required).
 */
function compileUnion(caseInsensitive: boolean): RegExp | null {
  const filtered = SECRET_PATTERNS.filter(
    (p) => p.flags.includes('i') === caseInsensitive
  );
  if (filtered.length === 0) return null;
  const body = filtered.map((p) => `(?:${p.source})`).join('|');
  return new RegExp(body, caseInsensitive ? 'gi' : 'g');
}

const SECRET_UNION_CS: RegExp | null = compileUnion(false);
const SECRET_UNION_CI: RegExp | null = compileUnion(true);

function replaceUnionMatch(match: string, ...args: unknown[]): string {
  const source = args.at(-1) as string;
  const offset = args.at(-2) as number;
  const nextChar = source[offset + match.length];
  if (match.endsWith('\\') && (nextChar === '"' || nextChar === "'")) {
    return match.length > 8 ? `${REDACTION_SENTINEL}\\` : match;
  }
  return REDACTION_SENTINEL;
}

const MAX_SINGLE_TOKEN_RUN_CHARS = 65_536;
const TOKEN_RUN_SAMPLE_EDGE = 1_024;

function isTokenStopChar(code: number): boolean {
  // Whitespace, quotes, backtick, comma, semicolon, ampersand.
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x60 ||
    code === 0x2c ||
    code === 0x3b ||
    code === 0x26
  );
}

/**
 * FR-R5-F14 (NS-08) — redact armored private-key blocks without unbounded `[\s\S]*` regex matches
 * that overflow V8's RegExp backtrack stack on multi-megabyte unterminated blocks.
 */
function redactPrivateKeyBlocks(input: string): string {
  const beginRe = new RegExp(PRIVATE_KEY_BEGIN_RE.source, 'g');
  const endRe = new RegExp(PRIVATE_KEY_END_RE.source, 'g');
  let cursor = 0;
  const parts: string[] = [];
  while (cursor < input.length) {
    beginRe.lastIndex = cursor;
    const beginMatch = beginRe.exec(input);
    if (!beginMatch) {
      if (cursor === 0) return input;
      parts.push(input.slice(cursor));
      break;
    }
    if (beginMatch.index > cursor) {
      parts.push(input.slice(cursor, beginMatch.index));
    }
    parts.push(REDACTION_SENTINEL);
    endRe.lastIndex = beginMatch.index + beginMatch[0].length;
    const endMatch = endRe.exec(input);
    if (!endMatch) {
      // Unterminated block: everything through end of input is redacted.
      cursor = input.length;
      break;
    }
    cursor = endMatch.index + endMatch[0].length;
  }
  return parts.join('');
}

function applyUnions(text: string): string {
  let out = text;
  if (SECRET_UNION_CS !== null) out = out.replace(SECRET_UNION_CS, REDACTION_SENTINEL);
  if (SECRET_UNION_CI !== null) out = out.replace(SECRET_UNION_CI, replaceUnionMatch);
  return out;
}

/**
 * FR-R5-F14 (NS-08) — V8's Irregexp engine pushes one backtrack frame per character when a
 * character-class quantifier (`[^\s"'\`,;&]{8,}`, `[A-Za-z0-9_-]{20,}`) sits at the end of a
 * regex branch, overflowing the RegExp stack around ~5-6M contiguous characters. When an input
 * exceeds 64 KiB and contains a single non-delimiter run over 64 KiB, fold the interior of any
 * run whose prefix/suffix sample is redacted as a single token so `applyUnions` runs in bounded
 * stack space.
 */
function collapseOversizedTokenRuns(input: string): string {
  let runStart = -1;
  const pieces: string[] = [];
  let lastCopied = 0;

  const flushRun = (start: number, end: number): void => {
    if (end - start <= MAX_SINGLE_TOKEN_RUN_CHARS) return;
    const ctxStart = Math.max(0, start - 256);
    const ctxEnd = Math.min(input.length, end + 256);
    const sampleRun =
      input.slice(start, start + TOKEN_RUN_SAMPLE_EDGE) +
      input.slice(end - TOKEN_RUN_SAMPLE_EDGE, end);
    const probe = input.slice(ctxStart, start) + sampleRun + input.slice(end, ctxEnd);
    if (applyUnions(probe) !== probe) {
      pieces.push(input.slice(lastCopied, start), sampleRun);
      lastCopied = end;
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    if (isTokenStopChar(input.charCodeAt(i))) {
      if (runStart !== -1) {
        flushRun(runStart, i);
        runStart = -1;
      }
    } else if (runStart === -1) {
      runStart = i;
    }
  }
  if (runStart !== -1) {
    flushRun(runStart, input.length);
  }
  if (pieces.length === 0) return input;
  pieces.push(input.slice(lastCopied));
  return pieces.join('');
}

/**
 * The one own key that `out[key] = value` cannot create.
 *
 * `Object.prototype` defines an accessor for this name, so assigning it on a
 * plain object invokes the setter instead of creating an own data property.
 * `Object.keys` still enumerates it when it *is* an own key — which is exactly
 * what `JSON.parse` produces from model or CLI output.
 *
 * The name matches `src/audit/audit-payload.ts`, which declares the same
 * literal for the same concept, so one grep finds every site in the tree that
 * knows about this key. The two are independent declarations, not a shared
 * import: these modules have no dependency edge.
 */
const PROTOTYPE_SETTER_KEY = '__proto__';

/**
 * Where a `__proto__` own key's sanitized value goes instead. Brackets follow
 * the module's existing `[CIRCULAR]` convention — they mark a place the
 * sanitizer acted on. The name is inert: re-parsing a log line containing it
 * creates an ordinary own key and invokes no setter.
 */
const PROTO_RENAME_KEY = '[__proto__]';

export interface LogSink {
  appendLine(line: string): void;
}

export class SanitizedLogger {
  private readonly sinks: LogSink[];
  /** FR-R4-F04 (C1) — merged under every call's own context; `undefined` on a window logger. */
  private readonly baseContext: Readonly<Record<string, unknown>> | undefined;

  constructor(sinks: LogSink[] = [], baseContext?: Readonly<Record<string, unknown>>) {
    this.sinks = sinks;
    this.baseContext = baseContext;
  }

  /**
   * FR-R4-F04 (C1, FR-033) — a logger that writes `base` on every line, for the code that runs for one
   * Run. It SHARES this logger's sinks (the same array, so a sink added later reaches it) and its
   * redaction, and merges `base` under each call's own context: on a clash the call wins. The parent is
   * unchanged, so a host line (activation, wiring, lock) carries no Run. Nothing infers a Run from timing.
   */
  public withContext(base: Readonly<Record<string, unknown>>): SanitizedLogger {
    return new SanitizedLogger(this.sinks, { ...this.baseContext, ...base });
  }

  public addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  public removeSink(sink: LogSink): void {
    const index = this.sinks.indexOf(sink);
    if (index !== -1) this.sinks.splice(index, 1);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', this.formatWithContext(message, context));
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', this.formatWithContext(message, context));
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.write('ERROR', this.formatWithContext(message, context));
  }

  /**
   * Feature 019 — emit a DEBUG record. `context` is folded into the
   * message string BEFORE sanitization so any secrets that leaked into
   * structured fields still pass through the SECRET_PATTERNS redaction
   * step in `write()`. Sinks downstream (e.g. RuntimeLogSink) may parse
   * the level token to apply severity filtering.
   *
   * Feature 019 BUG-001 — `info`, `warn`, and `error` now share the
   * same optional-`context` shape so operator-action call sites
   * (FR-021) can attach structured fields without dropping them into
   * the message via ad-hoc interpolation.
   */
  public debug(message: string, context?: Record<string, unknown>): void {
    this.write('DEBUG', this.formatWithContext(message, context));
  }

  private formatWithContext(message: string, context?: Record<string, unknown>): string {
    const merged = this.baseContext === undefined ? context : { ...this.baseContext, ...context };
    if (merged === undefined || merged === null) return message;
    let serialized: string;
    try {
      serialized = JSON.stringify(merged);
    } catch {
      serialized = '{"context-serialize-error":true}';
    }
    return `${message} ${serialized}`;
  }

  public sanitize(input: string): string {
    let out = input;
    // FR-R3-048 — private-key blocks first, ahead of the unions. See
    // `PRIVATE_KEY_ANY_RE`: leftmost-match lets an earlier-starting pattern
    // (`SECRET_KEY=…`, `sk-…`) eat the BEGIN marker and leave the body behind.
    if (out.includes(PRIVATE_KEY_MARKER_PREFIX)) {
      out = out.length > MAX_SINGLE_TOKEN_RUN_CHARS
        ? redactPrivateKeyBlocks(out)
        : out.replace(PRIVATE_KEY_ANY_RE, REDACTION_SENTINEL);
    }
    if (out.length > MAX_SINGLE_TOKEN_RUN_CHARS) {
      out = collapseOversizedTokenRuns(out);
    }
    return applyUnions(out);
  }

  /**
   * Feature 043 — recursively sanitize a record value without going
   * through `JSON.stringify` / `JSON.parse`. The structural walk
   * applies `sanitize()` to string leaves only, so a redaction pattern
   * that happens to match across JSON syntax boundaries can never
   * corrupt the serialized form. Cycles are intercepted via a
   * `WeakSet` and replaced with the sentinel string `'[CIRCULAR]'`.
   *
   * Function / symbol / bigint leaves are dropped on copy to mirror
   * the previous `JSON.stringify` behavior (audit-log writer and
   * phase-runner callers never pass these types).
   *
   * `SECRET_PATTERNS` remains the single source of truth — every
   * string leaf passes through `this.sanitize(leaf)` exactly once.
   *
   * FR-R3-166 — the caller ordering this method no longer depends on.
   * The trigger is: *log a model-derived object without projecting it
   * first.* `JSON.parse` of model or CLI output can produce an own
   * `__proto__` key, and until FR-R3-166 the object branch below lost
   * such a key's value or let it become the result's prototype.
   *
   * Two live callers were surveyed and both are safe, but by two
   * unrelated upstream guards, neither of which is a property of this
   * class and neither of which is discoverable from this file:
   *
   * - `src/audit/audit-log-writer.ts` sanitizes an entry whose
   *   `payload` has already passed finding 24's projection, which
   *   skips the key outright (`src/audit/audit-payload.ts`). Note the
   *   guard's actual width: it covers `payload` alone. The entry's
   *   other fields are spread in unprojected, and an object spread
   *   creates genuine own properties — so the ordering protects less
   *   than it appears to.
   * - `src/controller/phase-sidecar-reader.ts` sanitizes entries from
   *   `parsePhaseMessageEnv`, whose key allowlist rejects any name not
   *   matching `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`. `__proto__` fails on
   *   its leading underscore and never reaches this method.
   *
   * A third caller would inherit neither guard. The object branch now
   * holds the property itself, so the ordering is no longer
   * load-bearing for this hazard.
   */
  public sanitizeRecord<T extends Record<string, unknown>>(record: T): T {
    return this.sanitizeValue(record, new WeakSet<object>()) as T;
  }

  private sanitizeValue(input: unknown, seen: WeakSet<object>): unknown {
    if (typeof input === 'string') return this.sanitize(input);
    if (input === null) return null;
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'undefined') {
      return input;
    }
    if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint') {
      return undefined;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) return '[CIRCULAR]';
      seen.add(input);
      const out: unknown[] = [];
      for (const element of input) {
        const cleaned = this.sanitizeValue(element, seen);
        if (cleaned !== undefined) out.push(cleaned);
      }
      seen.delete(input);
      return out;
    }
    /**
     * FR-R3-166 (2026-09-05) — the disposition of an own `__proto__` key.
     *
     * The defect: this branch rebuilds onto a fresh `{}` and copies enumerated
     * keys with `out[key] = cleaned`. For an own `__proto__` key —
     * `JSON.parse('{"__proto__":…}')` produces exactly that — the assignment
     * creates no own property; it runs the `Object.prototype.__proto__`
     * setter. A string value is silently discarded. An object value becomes
     * the *result's* prototype, so the sanitized record answers reads with
     * model-derived data that appears on no key. The global `Object.prototype`
     * is not affected; the damage is confined to the returned instance.
     *
     * The ruling: **rename, do not preserve and do not drop.** The value is
     * kept under `PROTO_RENAME_KEY`, or the first unoccupied
     * `[__proto__](n)` if the input already carries that name.
     *
     * Weighed against feature 194's finding 24, which refused to let the
     * sanitizer carry the literal name `__proto__` into a durable sink (see
     * `src/audit/audit-payload.ts`, where the projection skips the key
     * outright). That reasoning governs this path too: the audit log is
     * structured and is read back, so a `"__proto__"` key sitting in durable
     * evidence is a hazard waiting for the next component that rebuilds an
     * object from it — which is the thing finding 24 declined. Renaming
     * carries the same information into the sink with strictly less hazard.
     * Dropping was refused separately: silent loss is the defect above,
     * and a drop that leaves no trace reproduces it under a better name.
     *
     * The hazard is the key *name*, not the assignment mechanism, so no
     * `Object.fromEntries`, `defineProperty`, or `Object.create(null)` is
     * needed. Every key that is not `__proto__` takes the identical
     * assignment it took before this change, which makes "unchanged for
     * ordinary input" a property of the code path rather than a measurement.
     * (`Object.create(null)` was measured and eliminated: it fails the
     * `Object.getPrototypeOf(result) === Object.prototype` boundary on every
     * input rather than fixing it on one.)
     *
     * A `__proto__` value that sanitizes to `undefined` is still elided, the
     * same as any other key. That is elision, not loss.
     *
     * Asserted by `tests/unit/lib/logger-proto-key.test.ts`, which reads the
     * behaviour rather than this comment.
     */
    if (typeof input === 'object') {
      if (seen.has(input as object)) return '[CIRCULAR]';
      seen.add(input as object);
      const out: Record<string, unknown> = {};
      const keys = Object.keys(input as Record<string, unknown>);
      for (const key of keys) {
        const child = (input as Record<string, unknown>)[key];
        // FR-R4-F10 (RD4; research R10) -- the string patterns see a leaf and never its key, so a
        // non-empty string under a key that names a secret is removed here. Every other leaf takes
        // the path it always took: numbers, booleans and null under the same key are kept.
        const cleaned =
          typeof child === 'string' && child.length > 0 && isSecretKeyName(key)
            ? REDACTION_SENTINEL
            : this.sanitizeValue(child, seen);
        if (cleaned === undefined) continue;
        out[key === PROTOTYPE_SETTER_KEY ? this.protoRenameTarget(keys) : key] = cleaned;
      }
      seen.delete(input as object);
      return out;
    }
    return undefined;
  }

  /**
   * The rename target for a `__proto__` own key: the first name in
   * `[__proto__]`, `[__proto__](2)`, `[__proto__](3)`, … that the input does
   * not already use.
   *
   * Chosen against the input's key set rather than the output's, so no input
   * value can be displaced — the rename must not introduce the silent loss it
   * exists to remove. The result is a function of the key set alone, not of
   * enumeration order. The loop terminates because each iteration yields a
   * fresh distinct candidate and only finitely many can be occupied; it runs
   * at all only for an input that already carries a `__proto__` own key.
   *
   * The key set is hashed once rather than scanned per candidate. Both review
   * passes on FR-R3-166 raised the same bound on the linear form: an input
   * carrying one `__proto__` key alongside N `[__proto__](n)` decoys walks N
   * candidates against an N-element scan. Neither live caller can present that
   * input — `src/audit/audit-payload.ts` drops the key before this method is
   * reachable, and `src/controller/phase-sidecar-reader.ts` admits no key
   * outside `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/` — so this is a bound for the
   * next caller, not a repair. `Set.has` and `Array.includes` agree on
   * strings, so the behaviour is unchanged.
   */
  private protoRenameTarget(ownKeys: readonly string[]): string {
    const occupied = new Set(ownKeys);
    let target = PROTO_RENAME_KEY;
    for (let n = 2; occupied.has(target); n += 1) target = `${PROTO_RENAME_KEY}(${n})`;
    return target;
  }

  private write(level: string, message: string): void {
    const sanitized = this.sanitize(message);
    const stamp = new Date().toISOString();
    const line = `[${stamp}] ${level} ${sanitized}`;
    for (const sink of this.sinks) {
      try {
        sink.appendLine(line);
      } catch {
        // sink failures must never propagate
      }
    }
  }
}

/**
 * FR-R4-F04 (C1, FR-033) — the logger for one phase invocation of one Run: every line it writes carries
 * `runId` and `phase`. Short enough to sit on a line of `phase-runner.ts` without changing its length.
 */
export function phaseLogger(logger: SanitizedLogger, ctx: { runId: string; phase: string }): SanitizedLogger {
  return logger.withContext({ runId: ctx.runId, phase: ctx.phase });
}

/**
 * FR-R3-048 (H-07), the half a regex cannot reach.
 *
 * `CliTransportSink` writes one record per CLI output line and sanitizes each
 * line on its own (`format()` -> `sanitizeLine(entry.line)`). A
 * `BEGIN[\s\S]*?END` expression can never match there: by the time the
 * sanitizer runs, the block is already split across calls. So fixing only
 * `SECRET_PATTERNS` yields a green suite and a transport log that still holds the
 * key -- the most dangerous outcome available, because every signal says the work
 * is done.
 *
 * THE ORDER IS DETECT-THEN-SANITIZE, AND THE REVERSE IS BROKEN
 *
 * The natural design -- sanitize the line, then open state if a BEGIN marker
 * survives -- does not work, and this was measured rather than reasoned about:
 * `PRIVATE_KEY_UNTERMINATED_RE` *consumes* the BEGIN marker on the first line, so
 * nothing survives to detect, the state never opens, and every body line flows
 * through unredacted. Detection therefore reads the RAW line.
 *
 * Redaction still happens only through `sanitize()`. The marker tests here are
 * *framing* detection, derived from the same `PRIVATE_KEY_ARMOR_LABELS`, so they
 * cannot drift from the pattern -- the no-fork rule holds.
 *
 * BOUNDED BY CONSTRUCTION
 *
 * State is a boolean and a counter -- never the lines, and never the label
 * either, because the close is deliberately label-agnostic and so has nothing to
 * compare a stored label against. So there is nothing buffered, which means
 * nothing to release at stream end, and size is O(1) per (run, stream) rather
 * than capped. The counter exists only to notice a block
 * that never closes; past the cap the redactor keeps redacting rather than
 * resuming, because a tail released after a cap is the leak the cap was for.
 */

/**
 * Lines a single open block may span before the redactor stops honouring END.
 *
 * Not a release point -- see above; past the cap the block never closes, so the
 * remainder of the stream stays suppressed. That is what bounds the one
 * pathological shape the lenient close accepts: a crafted body line spelling a
 * well-formed END marker can release a tail, but only within the first
 * `MAX_KEY_BLOCK_LINES` lines of the block.
 *
 * A 4096-bit RSA key armors to roughly 50 lines and the largest realistic key an
 * order of magnitude more, so this is far above any real block while still being
 * a constant.
 */
export const MAX_KEY_BLOCK_LINES = 10_000;

/**
 * Line redactor for one (run, stream) pair, so an open block on one Run's stdout
 * suppresses neither that Run's stderr nor any other Run's output.
 *
 * Instances are NOT dropped when a stream ends: this sink has no per-run terminal
 * callback, and inventing a caller for one reaches into the controller. The
 * registry that owns the instances bounds itself by eviction instead, and that
 * eviction prefers a CLOSED instance -- see `createCliTransportSink`. Nothing is
 * buffered here, so an instance that is still open at stream end holds no lines
 * to release; what an eviction would discard is the knowledge that suppression is
 * in force, which is why the preference exists.
 */
export class KeyBlockLineRedactor {
  private open = false;
  private linesSinceOpen = 0;

  public constructor(private readonly sanitizeWholeString: (input: string) => string) {}

  /** `true` while a block is open. Exposed for assertions, not for control flow. */
  public get isOpen(): boolean {
    return this.open;
  }

  public sanitizeLine(line: string): string {
    if (this.open) {
      // The counter is READ, not merely kept: past the cap we stop testing for
      // END, so the block can never close and the rest of the stream stays
      // suppressed. Resuming there would release exactly the tail the cap exists
      // to contain, and the counter clamps so it is bounded as well as O(1).
      //
      // The END test is the guard on the positional work below: a body line
      // carries no END, so the suppressed path stays at one regex pass per line.
      if (this.linesSinceOpen < MAX_KEY_BLOCK_LINES && PRIVATE_KEY_END_RE.test(line)) {
        // Closing needs a well-formed END for a private-key label -- but not
        // necessarily the label that opened the block: concatenated or re-armored
        // keys legitimately mismatch, and a strict match would hold suppression
        // open for the rest of the stream on a shape that occurs in practice.
        //
        // `'opened'` here is the shared-line case: the END that would have closed
        // this block is followed on the SAME line by the next key's BEGIN, so the
        // stream is still inside a block and suppression must not lift. Only the
        // counter restarts, for the new block.
        if (this.markerTransition(line) === 'closed') {
          this.open = false;
        }
        this.linesSinceOpen = 0;
      } else if (this.linesSinceOpen < MAX_KEY_BLOCK_LINES) {
        this.linesSinceOpen += 1;
      }
      return REDACTION_SENTINEL;
    }

    // Detection reads the RAW line, before sanitizing removes the marker. From a
    // closed state only an `'opened'` transition matters, and that needs a BEGIN,
    // so the BEGIN test guards the positional work.
    //
    // And the substring scan guards the BEGIN test, for the reason
    // `PRIVATE_KEY_MARKER_PREFIX` exists: every match of `PRIVATE_KEY_BEGIN_RE`
    // starts with that literal, so a line without it cannot match and does not
    // need a regex at all. On the overwhelmingly common line that holds no marker
    // this is one `indexOf` rather than a regex pass -- FR-022 asks that the added
    // per-line work be a check, and this path runs on every CLI output line.
    const hasBegin =
      line.includes(PRIVATE_KEY_MARKER_PREFIX) && PRIVATE_KEY_BEGIN_RE.test(line);

    // THE STATE OPENS BEFORE THE LINE IS SANITIZED, AND THE ORDER IS THE POINT.
    //
    // `sanitizeWholeString` is the one thing here that can throw -- a regex or
    // allocation failure on a stream-json line that is megabytes long -- and
    // `CliTransportSink.record()` catches exactly that and drops the line. If the
    // state were opened after the call, that throw would drop the BEGIN line and
    // leave the redactor CLOSED, so every body line of the key would then be
    // written verbatim: the one failure mode the sink's "every line must reach the
    // redactor" ordering exists to prevent. Opening first fails closed instead.
    if (hasBegin && this.markerTransition(line) === 'opened') {
      this.open = true;
      this.linesSinceOpen = 0;
    }
    return this.sanitizeWholeString(line);
  }

  /**
   * What one raw line does to the block state, by marker POSITION.
   *
   * Presence is not enough, and that is the whole reason this exists. `cat key1
   * key2` where the first file has no trailing newline puts a well-formed END and
   * the next key's BEGIN on ONE line: an `END RSA PRIVATE KEY` footer whose
   * closing dashes run straight into the `BEGIN RSA PRIVATE KEY` header after it.
   * A presence-only reading closes the open block there and never reopens, so the
   * second key's body and footer stream out one verbatim record at a time --
   * while from a closed state the same line reads as opened-and-closed and the
   * body that follows it leaks the same way. Concatenated keys are the shape the
   * spec already names as occurring in practice, so this is not hypothetical.
   *
   * The rule is simply which marker comes LAST: a trailing BEGIN leaves the
   * stream inside a block, a trailing END leaves it outside one, and a line with
   * neither says nothing. A whole block on one line therefore still does not open
   * the state -- its END follows its BEGIN -- so the single-line case the
   * whole-string pattern already handles is unchanged.
   */
  private markerTransition(line: string): MarkerTransition {
    const lastBegin = lastMarkerEnd(PRIVATE_KEY_BEGIN_GLOBAL_RE, line);
    const lastEnd = lastMarkerEnd(PRIVATE_KEY_END_GLOBAL_RE, line);
    if (lastBegin > lastEnd) return 'opened';
    if (lastEnd > lastBegin) return 'closed';
    return 'none';
  }
}

