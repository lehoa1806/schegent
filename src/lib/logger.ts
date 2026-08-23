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

/** A complete block: BEGIN through the next END. Non-greedy on purpose. */
const PRIVATE_KEY_BLOCK_RE = new RegExp(
  `-----BEGIN ${ARMOR_LABEL_ALTERNATION}-----[\\s\\S]*?-----END ${ARMOR_LABEL_ALTERNATION}-----`,
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
  // GitHub personal access tokens (classic + fine-grained)
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack bot/user/app/refresh/legacy tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
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
  // GCP service account snippet
  /"private_key"\s*:\s*"-----BEGIN [^"]+-----[\s\S]+?-----END [^"]+-----\\n?"/g,
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
  // Bearer / Authorization headers
  /Bearer\s+[A-Za-z0-9_\-.=]{16,}/gi,
  /authorization["'\s:=]+[A-Za-z0-9_\-.=]{16,}/gi,
  // api_key / apikey / api-key
  /api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
  // X-API-Key / X_API_KEY header style — common AWS API Gateway and
  // third-party SaaS shape that the api_key pattern misses because of
  // the `x-` prefix.
  /x[_-]api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
  // JSON Web Tokens
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Generic KEY=VALUE secrets in env-style strings
  /\b(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z_]*\s*=\s*[A-Za-z0-9_\-/+=]{8,}/g
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

export interface LogSink {
  appendLine(line: string): void;
}

export class SanitizedLogger {
  private readonly sinks: LogSink[];

  constructor(sinks: LogSink[] = []) {
    this.sinks = sinks;
  }

  public addSink(sink: LogSink): void {
    this.sinks.push(sink);
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
    if (context === undefined || context === null) return message;
    let serialized: string;
    try {
      serialized = JSON.stringify(context);
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
      out = out.replace(PRIVATE_KEY_ANY_RE, REDACTION_SENTINEL);
    }
    if (SECRET_UNION_CS !== null) out = out.replace(SECRET_UNION_CS, REDACTION_SENTINEL);
    if (SECRET_UNION_CI !== null) out = out.replace(SECRET_UNION_CI, REDACTION_SENTINEL);
    return out;
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
    if (typeof input === 'object') {
      if (seen.has(input as object)) return '[CIRCULAR]';
      seen.add(input as object);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>)) {
        const cleaned = this.sanitizeValue((input as Record<string, unknown>)[key], seen);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      seen.delete(input as object);
      return out;
    }
    return undefined;
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

