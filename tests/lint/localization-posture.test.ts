import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const POSTURE_DOC = 'docs/concepts/english-only-not-localizable.md';
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * Every failure in this file names the posture document, so a contributor who
 * trips a gate reads the decision instead of working around the assertion.
 */
const seeDoc = (what: string): string =>
  `${what}. The localization posture is recorded in ${POSTURE_DOC}; read it before changing this.`;

type Posture = 'english-only' | 'localizable';

/**
 * The posture is read out of the document rather than hard-coded here. An
 * operator who decides to localize edits one line in the document and this gate
 * follows. A gate you must delete to change your mind is a gate that gets
 * deleted.
 */
function readPosture(): Posture {
  const path = resolve(ROOT, POSTURE_DOC);
  expect(existsSync(path), seeDoc('the posture document is missing')).toBe(true);
  const lines = read(POSTURE_DOC)
    .split('\n')
    .map((line) => /^Posture:\s*(\S+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  expect(lines.length, seeDoc('expected exactly one `Posture:` declaration line')).toBe(1);
  const value = lines[0][1];
  expect(
    value,
    seeDoc(`\`Posture: ${value}\` is not a recognized posture`)
  ).toMatch(/^(english-only|localizable)$/);
  return value as Posture;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

function contributesStrings(): Array<{ path: string; value: string }> {
  const manifest = JSON.parse(read('package.json')) as { contributes?: unknown };
  const found: Array<{ path: string; value: string }> = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      found.push({ path, value: node });
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        visit(value, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(manifest.contributes, 'contributes');
  return found;
}

describe('localization posture', () => {
  it('is declared in exactly one place, in a form this gate can read', () => {
    // readPosture() asserts there is exactly one declaration and that its value
    // is recognized. It deliberately does NOT assert *which* value: pinning
    // `english-only` here would mean an operator who decides to localize has to
    // edit this test, which is the obstacle the posture-reading design exists to
    // remove. Flipping the line is a reviewable one-line diff in a
    // version-controlled document; that is the right place for the decision to
    // be visible, not a test failure.
    readPosture();
    const doc = read(POSTURE_DOC);
    expect(doc).toContain('Status: Accepted product-boundary decision');
    expect(doc).toContain('tests/lint/localization-posture.test.ts');
    // The reversal condition is the half of a posture that keeps it a decision
    // rather than an inheritance.
    expect(doc).toContain('The condition that would reopen this');
  });

  it('has no localization mechanism while the posture is english-only', () => {
    if (readPosture() !== 'english-only') return;

    const nls = readdirSync(ROOT).filter((entry) => /^package\.nls.*\.json$/.test(entry));
    expect(nls, seeDoc(`unexpected manifest NLS bundle(s): ${nls.join(', ')}`)).toEqual([]);

    const manifest = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect('l10n' in manifest, seeDoc('package.json declares an `l10n` bundle directory')).toBe(
      false
    );

    expect(existsSync(resolve(ROOT, 'l10n')), seeDoc('an `l10n/` directory exists')).toBe(false);

    const l10nCalls = walk('src')
      .filter((path) => path.endsWith('.ts'))
      .filter((path) => /vscode\.l10n/.test(read(path)));
    expect(l10nCalls, seeDoc(`vscode.l10n is used in ${l10nCalls.join(', ')}`)).toEqual([]);

    // The whole `contributes` subtree, not an enumerated field list: VS Code
    // substitutes `%key%` in any manifest string, including fields that do not
    // exist in this manifest yet.
    const placeholders = contributesStrings().filter(({ value }) => /^%.+%$/.test(value));
    expect(
      placeholders.map((entry) => entry.path),
      seeDoc('manifest strings use the `%key%` NLS placeholder form')
    ).toEqual([]);
  });

  it('has no webview module presenting itself as a localization boundary', () => {
    if (readPosture() !== 'english-only') return;

    const files = walk('webview-ui/src');

    // Named for the exact prior shape rather than a heuristic. `messages.*` is
    // deliberately NOT in this family: `webview-ui/src/lib/messages.ts`
    // re-exports `src/contracts/sidebar-ipc.js`, where "messages" means IPC
    // messages. Including it would have failed this gate on the tree the day it
    // was written — the same false-positive class as `src/ui/notifications.ts`
    // and the host `show*Message` adapters on the host side, which is why the
    // identifier rule below keys on `t` / `DEFAULT_LOCALE` / `MessageId` rather
    // than on the word "message".
    const namedForLocalization = files.filter((path) =>
      /\/(i18n|l10n|locale|localization|localisation|translation|translations|strings)\.[^/]+$/.test(
        path
      )
    );
    expect(
      namedForLocalization,
      seeDoc(`file(s) named for localization: ${namedForLocalization.join(', ')}`)
    ).toEqual([]);

    const catalogueShaped = files
      .filter((path) => path.endsWith('.ts') || path.endsWith('.svelte'))
      .filter((path) => {
        const source = read(path);
        return (
          /export\s+(const|function|let)\s+t\b/.test(source) ||
          /\bDEFAULT_LOCALE\b/.test(source) ||
          /\bMessageId\b/.test(source)
        );
      });
    expect(
      catalogueShaped,
      seeDoc(`message-catalogue shape reappeared in ${catalogueShaped.join(', ')}`)
    ).toEqual([]);
  });

  it('keeps the four formerly-externalized strings inline where they render', () => {
    // Nothing else in either suite asserts these four texts — the only file that
    // ever contained them was the deleted i18n.ts. Without this, inlining them
    // would be an unverified edit.
    const fieldRow = read(
      'webview-ui/src/components/settings/general/GeneralSettingFieldRow.svelte'
    );
    // Pinned as whole option elements: the bare word `Off` already appears in
    // this file's `loggingVerbose` label, so a substring check would pass
    // without proving the select label survived.
    expect(fieldRow).toContain('<option value="always">Always retain</option>');
    expect(fieldRow).toContain('<option value="errors-only">Errors only</option>');
    expect(fieldRow).toContain('<option value="off">Off</option>');

    const costChart = read('webview-ui/src/components/MetricsDashboard/MetricsCostChart.svelte');
    expect(costChart).toContain('Hover or focus a point on the chart for exact values.');
  });
});
