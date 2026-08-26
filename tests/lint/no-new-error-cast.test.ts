import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/lib/errors';

/**
 * FR-R3-110 (FR-107) — a shrink-only baseline on `(err as Error).message`, and a normalizer for
 * the correct form.
 *
 * WHY THE CAST IS A DEFECT AND NOT A STYLE CHOICE. `catch` binds `unknown`, and JavaScript
 * permits throwing anything. The cast is an instruction to the compiler not to check, so
 * `throw 'boom'` — from a dependency, a rejected promise, a `JSON.parse` of a non-object —
 * makes the expression evaluate to `undefined`, and the diagnostic reads `phase failed:
 * undefined`. Every one of these sites is on an error path: the place diagnostics matter most
 * and are exercised least.
 *
 * WHY A RATCHET AND NOT A SWEEP. 151 sites. `FR-R3-039`/`FR-R3-088`'s recorded convention is
 * exactly this: absorb the existing count, refuse growth, shrink over time. A bulk rewrite of
 * 151 error paths in one change would be a large diff whose review value is near zero and whose
 * risk is not — and `AGENTS.md`'s work-style rule forbids the drive-by.
 *
 * SHRINK-ONLY means the number may go DOWN without touching this file, and up never. A
 * contributor who converts a handful of sites does not have to edit a baseline; one who adds a
 * cast does.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(REPO_ROOT, 'src');

/**
 * The count when this ratchet landed, 2026-08-26 (`FR-R3-110`).
 *
 * **152, and the source item was right.** An earlier draft of this file said 151, from
 * `grep -rn "as Error).message" src/ | wc -l` — which counts LINES, and one line carries two
 * casts. The regex below counts occurrences, which is what a ratchet on sites must do, and it
 * disagreed with the baseline on its first run. Recorded because it is the same class of error
 * this whole item is about: a number that looked measured and was measured slightly wrong, and
 * the check that caught it was the one whose baseline it was.
 *
 * **Then lowered to 140.** The twelve casts in the three files this feature already edits
 * (`run-driver.ts`, `spawn-identity-recorder.ts`, `claude-cli-monitor.ts`) were converted in
 * the same change — not a drive-by, since those files are already in the diff, and a normalizer
 * shipped with no caller is a normalizer nobody adopts. The remaining 140 are the ratchet's
 * actual job.
 */
const BASELINE = 140;

/** `(x as Error).message`, in the forms this codebase writes it. */
const CAST = /as Error\)\.message/g;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function castSites(): ReadonlyArray<{ readonly file: string; readonly count: number }> {
  const sites: Array<{ file: string; count: number }> = [];
  for (const file of tsFiles(SRC)) {
    const count = (readFileSync(file, 'utf8').match(CAST) ?? []).length;
    if (count > 0) sites.push({ file: relative(REPO_ROOT, file), count });
  }
  return sites;
}

const total = (): number => castSites().reduce((sum, entry) => sum + entry.count, 0);

describe('FR-R3-110 — the error-cast baseline is shrink-only', () => {
  it('scanned a non-trivial source tree', () => {
    // Without this floor a directory rename would report zero casts, which would read as
    // spectacular progress and assert nothing.
    expect(tsFiles(SRC).length).toBeGreaterThan(200);
  });

  it('the count has not grown past the baseline', () => {
    const now = total();
    expect(
      now,
      `(err as Error).message appears ${now} times, over the ${BASELINE}-site baseline recorded ` +
        'on 2026-08-26. `catch` binds `unknown` and anything can be thrown, so this cast makes ' +
        'a diagnostic read "undefined" when a non-Error is thrown. Use ' +
        '`errorMessage(thrown)` from src/lib/errors.ts instead.'
    ).toBeLessThanOrEqual(BASELINE);
  });

  it('reports the slack, so a stale baseline is visible rather than comfortable', () => {
    // A baseline far above the real count is a ratchet that has stopped ratcheting: it would
    // permit dozens of new casts before anyone noticed. Printed rather than asserted, because
    // failing on slack would punish exactly the conversions this is meant to encourage.
    const now = total();
    if (now < BASELINE) {
      console.log(
        `no-new-error-cast: ${now} sites against a ${BASELINE} baseline — ${BASELINE - now} of ` +
          'slack. Lower BASELINE to lock the progress in.'
      );
    }
    expect(now).toBeGreaterThanOrEqual(0);
  });

  it('NON-VACUITY: the detector matches the shape it is meant to catch', () => {
    expect('foo((err as Error).message)'.match(CAST)).toHaveLength(1);
    expect('foo(errorMessage(err))'.match(CAST)).toBeNull();
  });
});

describe('FR-R3-110 — errorMessage handles what the cast could not', () => {
  it('an Error gives its message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('a thrown STRING gives itself, where the cast gave undefined', () => {
    // The whole point. `(('boom') as unknown as Error).message` is `undefined`.
    expect(errorMessage('boom')).toBe('boom');
  });

  it('never returns an empty string, for any input', () => {
    const inputs: unknown[] = [
      new Error(''),
      new TypeError(''),
      '',
      '   ',
      null,
      undefined,
      0,
      false,
      42,
      {},
      [],
      { message: 'from a plain object' },
      { message: '' },
      Symbol('sym'),
      () => undefined,
      123n
    ];
    for (const input of inputs) {
      const message = errorMessage(input);
      expect(typeof message, `${String(input)} must produce a string`).toBe('string');
      expect(message.length, `${String(input)} must produce a NON-EMPTY string`).toBeGreaterThan(0);
    }
  });

  it('describes a bare object rather than interpolating it', () => {
    // `String({})` is `[object Object]`, which looks like content and is not.
    expect(errorMessage({})).toContain('non-Error object thrown');
    expect(errorMessage({})).not.toContain('[object Object]');
  });

  it('uses a plain object`s own message when it has a usable one', () => {
    // A library that rejects with `{ message }` instead of an Error is the common shape.
    expect(errorMessage({ message: 'rejected by the library' })).toBe('rejected by the library');
    // ...but an empty one falls back to a description rather than to nothing.
    expect(errorMessage({ message: '   ' })).toContain('non-Error object thrown');
  });

  it('names an Error whose message is empty, rather than returning nothing', () => {
    expect(errorMessage(new Error(''))).toContain('no message');
    expect(errorMessage(new TypeError(''))).toContain('TypeError');
  });

  it('distinguishes null from undefined, because they arrive from different mistakes', () => {
    expect(errorMessage(null)).toBe('null thrown');
    expect(errorMessage(undefined)).toBe('undefined thrown');
  });
});
