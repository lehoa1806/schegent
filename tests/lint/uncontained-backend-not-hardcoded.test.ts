import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-056 (H-01) — the posture must come from the operator, not from a literal.
 *
 * `uncontainedGranted` is a required option so `tsc` enumerates every construction
 * site. That stops a site being *added* without stating a posture; it does not
 * stop one stating the grant inline. A single production site writing
 * `uncontainedGranted: new Set(['claude'])` re-opens the default path and nothing
 * else would notice, because the type is satisfied and every test still passes.
 *
 * FR-R3-125 — the option was `allowUncontained: boolean` and the forbidden shape
 * was the literal `true`. It is now a set of backend ids, so the forbidden shape
 * is a set built from an id literal. The empty set is fine and is what a caller
 * with nothing granted passes.
 *
 * Tests may hardcode it freely — that is what a test double is for — so only
 * `src/` is scanned.
 */
const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * A literal acceptance: a grant naming a backend id inline, in any spacing.
 *
 * `SUPPORTED_BACKENDS` is included because "grant everything the product has" is
 * the same defect spelled without a quote.
 */
const HARDCODED_GRANT =
  /uncontainedGranted\s*:[^;\n]*(['"`](?:claude|agy|codex)['"`]|SUPPORTED_BACKENDS)/;

/** Any mention, so the gate can prove it is looking at something. */
const ANY_MENTION = /uncontainedGranted|uncontainedBackends/;

/**
 * FR-R3-146 (FR-003) — a grant that is READ per construction, not STORED.
 *
 * The `getConfiguration` assertion below proves the read exists. It does not
 * prove the read's RESULT is unstored, and until this gate was added it was not:
 * `backend-execution-wiring.ts` called `readUncontainedGrant()` once at
 * activation and froze `uncontainedGrant.granted` into a registry that lives for
 * the window. So a grant written at runtime — by an operator editing settings
 * mid-session, or by the consent modal FR-R3-146 adds — was invisible until the
 * window reloaded, and the rule two lines below this one was written, gated, and
 * violated at the same time.
 *
 * The forbidden shape is therefore a value, and the required shape is a thunk:
 * `uncontainedGranted: () => …`. Tests may pass a set freely — only `src/` is
 * scanned — because a test double's lifetime is one assertion.
 */
const GRANT_ASSIGNMENT = /uncontainedGranted\s*:\s*/g;
const THUNK = /^\(\s*\)\s*=>/;

/**
 * True when any `uncontainedGranted:` in `body` is followed by something other
 * than a thunk.
 *
 * Written as a scan rather than one regex with a negative lookahead: a lookahead
 * placed after `\s*` is defeated by backtracking — the engine matches zero
 * whitespace, lands on the space before `(`, and the lookahead "fails" against a
 * thunk that is in fact there. Deciding the tail explicitly cannot be
 * backtracked into a false positive.
 */
function storesGrant(body: string): boolean {
  for (const match of body.matchAll(GRANT_ASSIGNMENT)) {
    const tail = body.slice(match.index + match[0].length);
    if (!THUNK.test(tail)) return true;
  }
  return false;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the uncontained posture is never hardcoded in production code', () => {
  const files = sources(SRC).map((file) => ({
    path: relative(SRC, file).split(/[/\\]/).join('/'),
    body: readFileSync(file, 'utf8')
  }));

  it('finds the option in src at all', () => {
    // Guards the whole file: after a rename this gate would pass by scanning for
    // a name nothing uses.
    expect(files.filter((f) => ANY_MENTION.test(f.body)).map((f) => f.path).length)
      .toBeGreaterThan(1);
  });

  it('has no inline grant naming a backend under src/', () => {
    const offenders = files.filter((f) => HARDCODED_GRANT.test(f.body)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('catches the shape it forbids — proved, not assumed', () => {
    // The predicate is "no offender", which passes over an empty scan or a regex
    // that matches nothing. Both spellings of the offence are driven through it,
    // and the legitimate empty grant is driven through too.
    expect(HARDCODED_GRANT.test("uncontainedGranted: new Set<BackendRunnerKind>(['claude'])")).toBe(
      true
    );
    expect(HARDCODED_GRANT.test('uncontainedGranted: new Set(SUPPORTED_BACKENDS)')).toBe(true);
    expect(HARDCODED_GRANT.test('uncontainedGranted: grant.granted')).toBe(false);
    expect(HARDCODED_GRANT.test('uncontainedGranted: new Set()')).toBe(false);
  });

  it('has no stored grant under src/ — the value is read per construction', () => {
    const offenders = files.filter((f) => storesGrant(f.body)).map((f) => f.path);
    expect(
      offenders,
      'FR-R3-146 (FR-003): `uncontainedGranted` must be a thunk called at judgement time. ' +
        'A resolved set assigned here is captured for the lifetime of whatever holds it — ' +
        'the registry outlives the window — so a grant written at runtime is not visible ' +
        'until the window reloads. Pass `() => readUncontainedGrant().granted`.'
    ).toEqual([]);
  });

  it('catches the stored shape it forbids — proved, not assumed', () => {
    // Same non-vacuity discipline as above. The first line is the exact text this
    // gate was written against, at `backend-execution-wiring.ts:269`.
    expect(storesGrant('uncontainedGranted: uncontainedGrant.granted')).toBe(true);
    expect(storesGrant('uncontainedGranted: new Set()')).toBe(true);
    expect(storesGrant('uncontainedGranted: this.granted')).toBe(true);
    // The declared type is the same offence: a set-typed field cannot be read.
    expect(storesGrant('readonly uncontainedGranted: ReadonlySet<BackendRunnerKind>;')).toBe(true);
    expect(storesGrant('uncontainedGranted: () => readUncontainedGrant().granted')).toBe(false);
    expect(storesGrant('uncontainedGranted: () => grant.granted')).toBe(false);
    expect(storesGrant('readonly uncontainedGranted: () => ReadonlySet<BackendRunnerKind>;')).toBe(
      false
    );
    // Spacing is not a way out, in either direction.
    expect(storesGrant('uncontainedGranted:()=>x')).toBe(false);
    expect(storesGrant('uncontainedGranted:  (  ) => x')).toBe(false);
    // One thunk does not excuse a stored sibling elsewhere in the same file.
    expect(storesGrant('uncontainedGranted: () => a\nuncontainedGranted: b')).toBe(true);
  });

  it('reads the value from configuration in the one place that supplies it', () => {
    // FR-R3-119 — the construction moved. `wireStage2()` in `src/extension.ts` was 1,221
    // lines; its backend-execution collaborators are now built in
    // `src/activation/backend-execution-wiring.ts`, which is `src/activation/` — the
    // directory ARCHITECTURE.md calls the composition root. This gate follows the
    // construction rather than the filename.
    const wiring = files.find((f) => f.path === 'activation/backend-execution-wiring.ts');
    expect(wiring).toBeDefined();
    expect(wiring?.body).toMatch(/uncontainedBackends/);
    // Read per construction, never stored: the hard rule against caching settings
    // on long-lived objects, and an operator who turns it off mid-session means it.
    expect(wiring?.body).toMatch(/getConfiguration\('schegent\.backend'\)/);
  });
});
