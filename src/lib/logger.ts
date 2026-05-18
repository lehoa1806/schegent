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
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
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
  // Bearer / Authorization headers
  /Bearer\s+[A-Za-z0-9_\-.=]{16,}/gi,
  /authorization["'\s:=]+[A-Za-z0-9_\-.=]{16,}/gi,
  // api_key / apikey / api-key
  /api[_-]?key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
  // JSON Web Tokens
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Generic KEY=VALUE secrets in env-style strings
  /\b(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z_]*\s*=\s*[A-Za-z0-9_\-/+=]{8,}/g
];

/**
 * Pre-compiled union regexes for the hot path. `sanitize()` formerly
 * iterated all 14 patterns per call (~14 regex passes per log line);
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
    if (SECRET_UNION_CS !== null) out = out.replace(SECRET_UNION_CS, '[REDACTED]');
    if (SECRET_UNION_CI !== null) out = out.replace(SECRET_UNION_CI, '[REDACTED]');
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
