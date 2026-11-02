/**
 * FR-R4-F10 (data-model section 2; FR-019, FR-022, FR-023, FR-033; contract RD, SK) -- the named
 * runtime redaction corpus: the statement of what the host's redactor supports, keeps, over-redacts
 * and does not support.
 *
 * WHAT IT IS FOR. `SECRET_PATTERNS` in `src/lib/logger.ts` is the one redaction authority, and "it
 * redacts secrets" is not a claim anyone can check. This corpus makes it one: each case has a name, a
 * category, an expected outcome and the sinks it applies to. `redacted` means no 8-character part of
 * the secret survives and every `keep` substring does; `preserved` means the text comes out
 * byte-identical (a negative control); `over-redacted` means an existing pattern removes something
 * benign, recorded so it is not mistaken for a negative; `unsupported` means the secret may remain,
 * with the reason. The unit test (`redaction-corpus.test.ts`) runs every case at `sanitize()` level,
 * and the five sink tests drive them through the real writers (contract SK).
 *
 * EACH CASE HAS ITS OWN SECRET. A secret is derived from its case's name by a seeded generator, so no two
 * cases share a substring of 8 characters. A sink test reads one artifact holding many cases, and a shared
 * filler would let one case's surviving secret (an unsupported case) fail another's absence check, or let
 * a leak in one pass because another happened to contain the same run.
 *
 * WHY EVERY VALUE IS BUILT AT CALL TIME. This file is tracked and the repository's own scan reads
 * tracked files, so a literal credential here would be a finding. Each value is assembled by a
 * function from split literals and filler, and is synthetic: shaped like a family's token and valid
 * for nothing. A failing assertion prints values only through `mask()`.
 *
 * BASELINE. `BASELINE_REDACTED` is the set of cases the redactor already redacted before this
 * feature changed it (captured against the unchanged `logger.ts`, tasks TA10). Every name in it must
 * stay redacted: hard rule 1 forbids weakening, and this list is how that is checked.
 */
import { SIGNATURE_STREAMS } from '../../src/lib/fatal-signature-registry';
import { mulberry32 } from './seeded-rng';

/** The five categories of sink a case can apply to (data-model section 5). */
export type SinkCategory = 'audit' | 'transport' | 'runtime-log' | 'webview-tail' | 'export';

export type RedactionCategory =
  | 'reproduced-gap'
  | 'existing-control'
  | 'vendor-prefix'
  | 'quoting-casing'
  | 'boundary'
  | 'multiline-key'
  | 'negative';

export type RedactionOutcome = 'redacted' | 'preserved' | 'over-redacted' | 'unsupported';

/**
 * How the sink test delivers a case: as a plain line, or in the shape its sink's framing needs.
 * `container-under-key` is for one recorded limit: the value is placed in an array under `key`. No sink
 * test selects it, because an `unsupported` case is printed and never asserted, so its `sinks` is empty;
 * the two walkers that make the limit are pinned in `redaction-structured-keys.test.ts` and
 * `phase-log-sanitizer.test.ts`.
 */
export type RedactionFraming = 'line' | 'split-key-block' | 'structured' | 'whole-artifact' | 'container-under-key';

export interface RedactionCase {
  /** Unique and human-readable. */
  readonly name: string;
  readonly category: RedactionCategory;
  readonly expected: RedactionOutcome;
  /** The input, built at call time. For a `structured` case, the value placed under `key`. */
  readonly build: () => string;
  /** The substring that must be ABSENT after redaction (`redacted`, `over-redacted`); at least 8 characters. */
  readonly secret?: () => string;
  /** Substrings that must REMAIN: the key name, the URL host, the username. */
  readonly keep?: ReadonlyArray<string>;
  /** Required for `unsupported` and `over-redacted`. */
  readonly reason?: string;
  readonly sinks: ReadonlyArray<SinkCategory>;
  /** Absent means a plain line. */
  readonly framing?: RedactionFraming;
  /** For a `structured` case: the key the value sits under. Absent means an array element. */
  readonly key?: string;
}

export const ALL_SINKS: ReadonlyArray<SinkCategory> = ['audit', 'transport', 'runtime-log', 'webview-tail', 'export'];
const STRUCTURED_SINKS: ReadonlyArray<SinkCategory> = ['audit', 'webview-tail', 'export'];
const TRANSPORT_ONLY: ReadonlyArray<SinkCategory> = ['transport', 'export'];
/**
 * Every sink but the audit log, for a case whose text is a URL or a path. The audit projection refuses
 * such a string outright (`path-or-endpoint-detected`, `src/audit/audit-payload.ts`), so the audit log
 * never carries one and the case has no audit presence to test.
 */
const NO_AUDIT: ReadonlyArray<SinkCategory> = ['transport', 'runtime-log', 'webview-tail', 'export'];

/**
 * The names of the cases the redactor redacted BEFORE this feature changed it, captured against the
 * unchanged `logger.ts` (tasks TA10). Every one must still be redacted.
 */
export const BASELINE_REDACTED: ReadonlyArray<string> = [
  "Anthropic key",
  "OpenAI project key",
  "OpenAI service-account key",
  "legacy sk- key",
  "GitHub classic token",
  "GitHub fine-grained token",
  "Slack bot token",
  "AWS access key id",
  "AWS session key id",
  "Google API key",
  "Google OAuth access token",
  "Stripe live secret key",
  "GCP service-account JSON envelope",
  "Bearer header",
  "authorization header",
  "api_key assignment",
  "x-api-key header",
  "JSON web token",
  "uppercase env-style secret",
  "vendor token as an array element",
  "secret at the start of the input",
  "secret at the end of the input",
  "secret between punctuation",
  "complete private-key block",
  "private-key block split across records with the footer beside the next header",
  "unterminated private-key block",
  "two adjacent private-key blocks",
  "a count named TOKEN_COUNT"
];

/** A value with only its first 4 characters kept, for failure messages (FR-033). */
export function mask(value: string): string {
  return value.length <= 4 ? '****' : `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 4, 12))}`;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_AND_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * `length` characters of `alphabet`, derived from `tag` alone (FNV-1a into the shared seeded generator).
 * Distinct tags give secrets that share no 8-character substring in practice, and the same tag always
 * gives the same secret, so a case builds afresh to the same value.
 */
function uniqueSecret(tag: string, length: number, alphabet: string = ALPHANUMERIC): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < tag.length; index += 1) {
    hash ^= tag.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const rng = mulberry32(hash);
  return Array.from({ length }, () => alphabet.charAt(Math.floor(rng() * alphabet.length))).join('');
}

/** A name ending in a password word, assembled so this file holds no `<name>=` text for the scan. */
const PASS = ['pass', 'word'].join('');
const PASS_UPPER = PASS.toUpperCase();

/** Base64-looking filler for a private-key body, unique per `tag`: no key decodes from it. */
function keyBody(lines: number, tag: string): string {
  return Array.from({ length: lines }, (_, row) => `MIIE${uniqueSecret(`${tag}:${row}`, 60)}`).join('\n');
}

/** The first row of a key body: the part that must not survive. */
function keyRow(tag: string): string {
  return keyBody(1, tag);
}

/** An armored private-key block, assembled so this file never spells a complete header. */
function keyBlock(label: string, lines: number, tag: string): string {
  return ['-----', `BEGIN ${label}PRIVATE`, ' KEY-----\n', keyBody(lines, tag), '\n-----', `END ${label}PRIVATE`, ' KEY-----'].join('');
}

/** A JWT-shaped token: two JSON objects as base64url, and `signature`. */
function jsonWebToken(signature: string): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [segment({ alg: 'HS256', typ: 'JWT' }), segment({ sub: 'user-1', scope: 'read' }), signature].join('.');
}

interface SecretOptions {
  readonly alphabet?: string;
  readonly extra?: Partial<RedactionCase>;
}

/** A `redacted` case: `template` places the case's own `length`-character secret in its text. */
function redacted(
  name: string,
  category: RedactionCategory,
  template: (secret: string) => string,
  length: number,
  options: SecretOptions = {}
): RedactionCase {
  const secret = (): string => uniqueSecret(name, length, options.alphabet);
  return {
    name,
    category,
    expected: 'redacted',
    build: () => template(secret()),
    secret,
    sinks: ALL_SINKS,
    ...options.extra
  };
}

function preserved(name: string, build: () => string, extra: Partial<RedactionCase> = {}): RedactionCase {
  return { name, category: 'negative', expected: 'preserved', build, sinks: ALL_SINKS, ...extra };
}

/** The four reproduced gaps (FR-019): shapes the shipped redactor passed unchanged. */
const REPRODUCED_GAPS: ReadonlyArray<RedactionCase> = [
  redacted('prefixed uppercase password assignment', 'reproduced-gap', (s) => `MY_DB_${PASS_UPPER}=${s}`, 24, {
    extra: { keep: [`MY_DB_${PASS_UPPER}=`] }
  }),
  redacted('lowercase password assignment', 'reproduced-gap', (s) => `db_${PASS}=${s}`, 24, {
    extra: { keep: [`db_${PASS}=`] }
  }),
  redacted(
    'URL userinfo password',
    'reproduced-gap',
    (s) => ['https', '://deploy:', s, '@git.example.org/r.git'].join(''),
    24,
    { extra: { keep: ['https://deploy:', '@git.example.org/r.git'], sinks: NO_AUDIT } }
  ),
  redacted('JSON client_secret', 'reproduced-gap', (s) => `{"client_secret": "${s}"}`, 24, {
    extra: { keep: ['"client_secret"'] }
  })
];

/** Each pattern the redactor already carried: all must stay redacted. */
const EXISTING_CONTROLS: ReadonlyArray<RedactionCase> = [
  redacted('Anthropic key', 'existing-control', (s) => `key ${['sk', '-ant-'].join('')}api03-${s} end`, 40),
  redacted('OpenAI project key', 'existing-control', (s) => `key ${['sk', '-proj-'].join('')}${s} end`, 40),
  redacted('OpenAI service-account key', 'existing-control', (s) => `key ${['sk', '-svcacct-'].join('')}${s} end`, 40),
  redacted('legacy sk- key', 'existing-control', (s) => `key ${['sk', '-'].join('')}${s} end`, 40),
  redacted('GitHub classic token', 'existing-control', (s) => `token ${['gh', 'p_'].join('')}${s} end`, 36),
  redacted('GitHub fine-grained token', 'existing-control', (s) => `token ${['github', '_pat_'].join('')}${s} end`, 40),
  redacted('Slack bot token', 'existing-control', (s) => `token ${['xo', 'xb-'].join('')}1234567890-1234567890-${s} end`, 24),
  redacted('AWS access key id', 'existing-control', (s) => `id ${['AK', 'IA'].join('')}${s} end`, 16, { alphabet: UPPER_AND_DIGITS }),
  redacted('AWS session key id', 'existing-control', (s) => `id ${['AS', 'IA'].join('')}${s} end`, 16, { alphabet: UPPER_AND_DIGITS }),
  redacted('Google API key', 'existing-control', (s) => `key ${['AI', 'za'].join('')}${s} end`, 35),
  redacted('Google OAuth access token', 'existing-control', (s) => `token ${['ya', '29.'].join('')}${s} end`, 40),
  redacted('Stripe live secret key', 'existing-control', (s) => `key ${['sk', '_live_'].join('')}${s} end`, 30),
  {
    name: 'GCP service-account JSON envelope',
    category: 'existing-control',
    expected: 'redacted',
    build: () => JSON.stringify({ type: 'service_account', private_key: `${keyBlock('', 2, 'GCP service-account JSON envelope')}\n` }),
    secret: () => keyRow('GCP service-account JSON envelope'),
    sinks: ALL_SINKS
  },
  redacted('Bearer header', 'existing-control', (s) => `request header Bearer ${s} end`, 24),
  redacted('authorization header', 'existing-control', (s) => `authorization: ${s}`, 24),
  redacted('api_key assignment', 'existing-control', (s) => `api_key=${s}`, 24),
  redacted('x-api-key header', 'existing-control', (s) => `x-api-key: ${s}`, 24),
  redacted('JSON web token', 'existing-control', (s) => `session ${jsonWebToken(s)} end`, 43),
  redacted('uppercase env-style secret', 'existing-control', (s) => `ACCESS_KEY=${s}`, 24)
];

/** Vendor prefixes FR-019 names. `gho_`, `ghu_`, `ghs_`, `ghr_` and `npm_` were not redacted before. */
const VENDOR_PREFIXES: ReadonlyArray<RedactionCase> = [
  redacted('GitHub OAuth token', 'vendor-prefix', (s) => `token ${['gh', 'o_'].join('')}${s} end`, 36),
  redacted('GitHub user-to-server token', 'vendor-prefix', (s) => `token ${['gh', 'u_'].join('')}${s} end`, 36),
  redacted('GitHub server-to-server token', 'vendor-prefix', (s) => `token ${['gh', 's_'].join('')}${s} end`, 36),
  redacted('GitHub refresh token', 'vendor-prefix', (s) => `token ${['gh', 'r_'].join('')}${s} end`, 36),
  redacted('npm token', 'vendor-prefix', (s) => `token ${['npm', '_'].join('')}${s} end`, 36)
];

/** A structured case: the value goes under `key`, or into an array when `key` is absent. */
function structured(name: string, build: (secret: string) => string, secretLength: number, key?: string): RedactionCase {
  const secret = (): string => uniqueSecret(name, secretLength);
  return {
    name,
    category: 'quoting-casing',
    expected: 'redacted',
    build: () => build(secret()),
    secret,
    sinks: STRUCTURED_SINKS,
    framing: 'structured',
    ...(key === undefined ? {} : { key })
  };
}

/** Quoting and casing variants of a keyed value, and the structured forms of the same keys. */
const QUOTING_AND_CASING: ReadonlyArray<RedactionCase> = [
  redacted('password with a colon and a space', 'quoting-casing', (s) => `${PASS}: ${s}`, 24, { extra: { keep: [`${PASS}: `] } }),
  redacted('password in single quotes', 'quoting-casing', (s) => `${PASS}='${s}'`, 24, { extra: { keep: [`${PASS}=`] } }),
  redacted('uppercase password in double quotes', 'quoting-casing', (s) => `${PASS_UPPER}="${s}"`, 24, {
    extra: { keep: [`${PASS_UPPER}=`] }
  }),
  redacted('YAML refresh token', 'quoting-casing', (s) => `refresh_token: ${s}`, 24, { extra: { keep: ['refresh_token: '] } }),
  redacted('mixed-case client secret', 'quoting-casing', (s) => `Client_Secret=${s}`, 24, { extra: { keep: ['Client_Secret='] } }),
  redacted('header-style token', 'quoting-casing', (s) => `X-Auth-Token: ${s}`, 24, { extra: { keep: ['X-Auth-Token: '] } }),
  redacted('JSON password', 'quoting-casing', (s) => `{"${PASS}":"${s}"}`, 24, { extra: { keep: [`"${PASS}"`] } }),
  structured('structured leaf under client_secret', (s) => s, 16, 'client_secret'),
  structured('structured leaf under a password key', (s) => s, 16, PASS),
  structured('structured leaf under a camelCase token key', (s) => s, 16, 'apiToken'),
  structured('vendor token as an array element', (s) => `${['gh', 'p_'].join('')}${s}`, 36)
];

/** Where a secret sits in the input: at its start, at its end, between punctuation, inside a longer name. */
const BOUNDARIES: ReadonlyArray<RedactionCase> = [
  redacted('secret at the start of the input', 'boundary', (s) => `${['gh', 'p_'].join('')}${s} was the first word`, 36),
  redacted('secret at the end of the input', 'boundary', (s) => `the last word is ${['gh', 'p_'].join('')}${s}`, 36),
  redacted('secret between punctuation', 'boundary', (s) => `("${['gh', 'p_'].join('')}${s}"),`, 36),
  redacted('keyed value after a name embedded in a longer word', 'boundary', (s) => `some${PASS}=${s}`, 24, {
    extra: { keep: [`some${PASS}=`] }
  })
];

/** A private-key case: `build` assembles the blocks from the case's own bodies, `secret` is a first row. */
function keyCase(name: string, build: (tag: string) => string, extra: Partial<RedactionCase> = {}): RedactionCase {
  return {
    name,
    category: 'multiline-key',
    expected: 'redacted',
    build: () => build(name),
    secret: () => keyRow(name),
    sinks: TRANSPORT_ONLY,
    framing: 'split-key-block',
    ...extra
  };
}

/** Private-key blocks, whole and as they arrive in the transport: complete, split, unterminated, adjacent. */
const MULTILINE_KEYS: ReadonlyArray<RedactionCase> = [
  keyCase('complete private-key block', (tag) => `before\n${keyBlock('RSA ', 3, tag)}\nafter`, { keep: ['before', 'after'] }),
  keyCase(
    'private-key block split across records with the footer beside the next header',
    (tag) => `${keyBlock('OPENSSH ', 2, tag)} ${keyBlock('EC ', 2, `${tag}:second`)}`
  ),
  keyCase(
    'unterminated private-key block',
    (tag) => `start\n${['-----', 'BEGIN RSA PRIVATE', ' KEY-----\n'].join('')}${keyBody(3, tag)}`
  ),
  keyCase('two adjacent private-key blocks', (tag) => `${keyBlock('RSA ', 2, tag)}\n${keyBlock('DSA ', 2, `${tag}:second`)}`)
];

/** Every built-in fatal signature (hard rule 17): the text must pass `sanitize()` byte-identical. */
const FATAL_SIGNATURE_NEGATIVES: ReadonlyArray<RedactionCase> = SIGNATURE_STREAMS.map((spec) =>
  preserved(`built-in fatal signature: ${spec.pattern}`, () => `${spec.pattern} (while reading the workspace)`)
);

/** Text that looks like a credential to a careless pattern and is not one (FR-023). */
const NEGATIVES: ReadonlyArray<RedactionCase> = [
  preserved('a commit hash', () => 'merged 9fceb02d0ae598e95dc970b74767f19372d61af8 into develop'),
  preserved('a UUID', () => 'run 123e4567-e89b-12d3-a456-426614174000 started'),
  preserved('an input_tokens count', () => 'usage input_tokens=123456789 for the call'),
  preserved('an output_tokens count in JSON', () => '{"usage": {"output_tokens": 123456789}}'),
  preserved('a max_tokens setting', () => 'max_tokens: 4096'),
  preserved('a file path', () => 'wrote /Users/someone/project/src/index.ts', { sinks: NO_AUDIT }),
  preserved('prose that mentions a password', () => 'the password is wrong, try again'),
  preserved('a URL without userinfo', () => 'see https://example.org/docs/page?a=1', { sinks: NO_AUDIT }),
  preserved('a URL whose path holds a colon and an at sign', () => 'see https://example.org/a:b@c', { sinks: NO_AUDIT }),
  preserved('a user-only SSH remote', () => 'cloned ssh://git@github.com/org/repo.git', { sinks: NO_AUDIT }),
  preserved('an SSH public key', () => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${uniqueSecret('an SSH public key', 32)} user@host`),
  preserved('a public key block', () =>
    ['-----', 'BEGIN PUBLIC', ' KEY-----\n', keyBody(1, 'a public key block'), '\n-----', 'END PUBLIC', ' KEY-----'].join('')
  ),
  preserved('the shell working directory', () => 'PWD=/tmp/example/work', { sinks: NO_AUDIT }),
  preserved('the shell previous directory', () => 'OLDPWD=/tmp/example/prev', { sinks: NO_AUDIT }),
  ...FATAL_SIGNATURE_NEGATIVES
];

/** A case the redactor is not expected to handle: `template` places its own secret. */
function limit(
  name: string,
  category: RedactionCategory,
  expected: 'unsupported' | 'over-redacted',
  template: (secret: string) => string,
  length: number,
  reason: string,
  extra: Partial<RedactionCase> = {}
): RedactionCase {
  const secret = (): string => uniqueSecret(name, length);
  return { name, category, expected, build: () => template(secret()), secret, reason, sinks: ALL_SINKS, ...extra };
}

/** Shapes the redactor does not remove, and one it removes although benign: stated, not hidden. */
const RECORDED_LIMITS: ReadonlyArray<RedactionCase> = [
  limit(
    'a secret split across two records',
    'boundary',
    'unsupported',
    (s) => `part one ${s}`,
    12,
    'Each record is read alone, so a credential whose halves arrive in two records matches no pattern in either half.'
  ),
  limit(
    'a lowercase secret_key_base assignment',
    'quoting-casing',
    'unsupported',
    (s) => `secret_key_base=${s}`,
    24,
    'The name does not end in a listed word, and the uppercase env rule is case-sensitive.'
  ),
  limit(
    'a bare token as URL userinfo',
    'negative',
    'unsupported',
    (s) => ['https', '://', s, '@git.example.org/r.git'].join(''),
    24,
    'Userinfo with no colon cannot be told from a username, and ssh://git@host must stay readable.',
    { sinks: NO_AUDIT }
  ),
  limit(
    'a token in a format no pattern knows',
    'negative',
    'unsupported',
    (s) => `internal credential ${s.slice(0, 12)}-${s.slice(12)}`,
    24,
    'A bespoke format with no vendor prefix or key name cannot be recognised without a pattern for it.'
  ),
  {
    name: 'a string-form keyed value under 8 characters',
    category: 'quoting-casing',
    expected: 'unsupported',
    build: () => `db_${PASS}=abc1234`,
    secret: () => 'abc1234',
    reason:
      'The keyed pattern asks for 8 characters, so prose such as "password: none" stays readable. A structured leaf under a secret key is removed at any length.',
    sinks: ALL_SINKS
  },
  limit(
    'a string-form camelCase password-suffix key',
    'quoting-casing',
    'unsupported',
    (s) => `dbPwd=${s}`,
    24,
    'The string pattern cannot tell dbPwd from the shell OLDPWD without case, so pwd counts only after a separator; the structured walker does see the key.'
  ),
  limit(
    'a container under a secret-named key',
    'quoting-casing',
    'unsupported',
    (s) => `internal credential ${s.slice(0, 12)}-${s.slice(12)}`,
    24,
    'Only a string directly under a key that names a secret is replaced; an array or an object under such a key is walked, so a string inside it in a format no pattern knows stays, and a vendor token inside it is still removed by pattern.',
    { sinks: [], framing: 'container-under-key', key: 'token' }
  ),
  {
    name: 'a count named TOKEN_COUNT',
    category: 'negative',
    expected: 'over-redacted',
    build: () => 'TOKEN_COUNT=48271905',
    secret: () => '48271905',
    reason:
      'The existing uppercase env rule removes any TOKEN_ value of 8 characters; narrowing it would weaken the redactor (hard rule 1).',
    sinks: ALL_SINKS
  }
];

/** Every case: the named corpus. */
export const REDACTION_CASES: ReadonlyArray<RedactionCase> = [
  ...REPRODUCED_GAPS,
  ...EXISTING_CONTROLS,
  ...VENDOR_PREFIXES,
  ...QUOTING_AND_CASING,
  ...BOUNDARIES,
  ...MULTILINE_KEYS,
  ...NEGATIVES,
  ...RECORDED_LIMITS
];
