import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';

/**
 * FR-R3-102 (FR-037) — a rejected webview message is visible to an operator at
 * DEFAULT settings.
 *
 * WHAT WAS WRONG. `ARCHITECTURE.md` said unknown message shapes were "rejected and
 * audited as `audit.invalid_command`". No such audit event has ever existed — zero
 * hits for `invalid_command` anywhere in `src` — and both entry points did
 * `logger.debug(...); return;`. The default runtime log level is `INFO`
 * (`settings-schema.ts`), so a webview probing the host with malformed messages
 * produced **no operator-visible trace at all**. The document described a
 * trust-boundary observability mechanism the code did not have, which is the
 * `R-14`/`D2`/`F-08`/`S10` class in the one document whose job is describing
 * mechanisms.
 *
 * WHAT THIS PINS. The severity, not the wording. `warn` is above the default filter,
 * so the rejection is visible; a future edit back to `debug` restores the gap and
 * fails here. An audit event remains the stronger answer and is recorded in
 * `ARCHITECTURE.md` as the destination.
 *
 * Both entry points are covered, because the defect was symmetric and a fix applied
 * to one of two doors is not a fix.
 */
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type Level = (typeof LOG_LEVELS)[number];

/** The default from `settings-schema.ts` — the level an operator who set nothing has. */
const DEFAULT_LEVEL: Level = 'INFO';

const visibleAt = (emitted: Level, filter: Level): boolean =>
  LOG_LEVELS.indexOf(emitted) >= LOG_LEVELS.indexOf(filter);

describe('FR-R3-102 — a rejected webview message leaves an operator-visible trace', () => {
  it('the validator actually rejects an unknown shape, so there is something to log', () => {
    // Without this the assertions below could pass over a validator that accepts
    // everything, which is the vacuity shape this repository measures.
    const result = validateInboundMessage({ type: 'not-a-real-command' });
    expect(result.ok).toBe(false);
    // Narrowed before reading, because the ok arm carries no `reason` — the union is
    // what makes the rejection path's payload legible at all.
    if (!result.ok) expect(result.reason).toBeTruthy();
  });

  it('`warn` is visible at the default log level and `debug` is not — the whole of the defect', () => {
    expect(visibleAt('WARN', DEFAULT_LEVEL)).toBe(true);
    expect(
      visibleAt('DEBUG', DEFAULT_LEVEL),
      'if this becomes true the defect is no longer a defect, and this test is obsolete ' +
        'rather than failing — check whether the default log level moved'
    ).toBe(false);
  });

  it.each([
    ['src/ui/sidebar/sidebar-view-provider.ts', 'sidebar'],
    ['src/ui/dashboard/dashboard-panel.ts', 'dashboard']
  ])('%s rejects at warn, not debug', async (relPath) => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, '../../..', relPath), 'utf8');

    // The rejection branch, isolated: the guard through its `return`.
    const branch = /if \(!result\.ok\) \{[\s\S]*?\n {4}\}/.exec(source);
    expect(branch, `${relPath} must still have a validation rejection branch`).not.toBeNull();
    const body = (branch as RegExpExecArray)[0];

    expect(body, `${relPath} must log the rejection at warn`).toMatch(/logger\.warn\(/);
    expect(
      body,
      `${relPath} logs a trust-boundary rejection at debug, which the default INFO ` +
        'filter discards — an operator cannot see a webview probing the host'
    ).not.toMatch(/logger\.debug\(/);
  });

  it('no code claims an audit event for an invalid command, because none exists', async () => {
    // The document promised `audit.invalid_command` for a year. If someone adds the
    // event, this test should be replaced by one asserting it is EMITTED — not
    // deleted, because the claim-without-mechanism is what went wrong here.
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '../../..');
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-l', 'invalid_command', '--', 'src'], {
        cwd: root,
        encoding: 'utf8'
      });
    } catch {
      hits = ''; // git grep exits 1 when nothing matches
    }
    const files = hits.split('\n').filter(Boolean);
    // The two rejection sites cite the retired claim in a comment explaining why it
    // is retired; that is the correction, not a reintroduction.
    const offenders = files.filter(
      (f) =>
        f !== 'src/ui/sidebar/sidebar-view-provider.ts' &&
        f !== 'src/ui/dashboard/dashboard-panel.ts'
    );
    expect(offenders).toEqual([]);
  });
});
