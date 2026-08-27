import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-056 (H-01) — the posture must come from the operator, not from a literal.
 *
 * `allowUncontained` is a required option so `tsc` enumerates every construction
 * site. That stops a site being *added* without stating a posture; it does not
 * stop one stating `true`. A single `allowUncontained: true` in production code
 * re-opens the default path and nothing else would notice, because the type is
 * satisfied and every test still passes.
 *
 * Tests may hardcode it freely — that is what a test double is for — so only
 * `src/` is scanned.
 */
const SRC = resolve(__dirname, '..', '..', 'src');

/** A literal acceptance, in any spacing. */
const HARDCODED_TRUE = /allowUncontained\s*:\s*true\b/;

/** Any mention, so the gate can prove it is looking at something. */
const ANY_MENTION = /allowUncontained/;

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

  it('has no literal `allowUncontained: true` under src/', () => {
    const offenders = files.filter((f) => HARDCODED_TRUE.test(f.body)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('reads the value from configuration in the one place that supplies it', () => {
    // FR-R3-119 — the construction moved. `wireStage2()` in `src/extension.ts` was 1,221
    // lines; its backend-execution collaborators are now built in
    // `src/activation/backend-execution-wiring.ts`, which is `src/activation/` — the
    // directory ARCHITECTURE.md calls the composition root. This gate follows the
    // construction rather than the filename.
    const wiring = files.find((f) => f.path === 'activation/backend-execution-wiring.ts');
    expect(wiring).toBeDefined();
    expect(wiring?.body).toMatch(/allowUncontainedBackends/);
    // Read per construction, never stored: the hard rule against caching settings
    // on long-lived objects, and an operator who turns it off mid-session means it.
    expect(wiring?.body).toMatch(/getConfiguration\('schegent\.backend'\)/);
  });
});
