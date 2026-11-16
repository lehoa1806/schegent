/**
 * Components read colour, type and borders through the `--schegent-*` tokens in
 * `lib/theme.css`, never a `--vscode-*` variable of their own, and set text in
 * the layer's text-safe colours, never in a saturated status accent.
 *
 * The token layer is where a VS Code variable gets its fallback, its high
 * contrast override and its text-safe mix (saturated accents never colour
 * small text). A component that reads the variable directly skips all three,
 * and a theme that leaves the variable unset paints it with the browser's
 * initial value instead. Variables the layer did not yet carry get a token
 * there first.
 *
 * The status accents (`--schegent-color-*`) fall below WCAG AA as text in a
 * light theme, so text takes the `--schegent-status-*-text` mix of the accent
 * and the foreground, and the accent itself stays on borders, fills, dots and
 * icons. The redesign sheets in `lib/sg` keep their own list of the icon
 * containers that may take an accent (`lib/__tests__/sg-stylesheets.test.ts`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = join(__dirname, '..');
const SOURCE_EXTENSIONS = ['.svelte', '.css', '.ts'];
const RAW_READ = 'var(--vscode-';
/** A `color` declaration, not `border-color` or a custom property, that starts at an accent. */
const SATURATED_TEXT = /(?<![-\w])color\s*:\s*var\(--schegent-color-/;

function componentSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...componentSources(path));
      continue;
    }
    if (entry.name.endsWith('.test.ts')) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

function linesMatching(file: string, matches: (line: string) => boolean): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      matches(line) ? [`${relative(COMPONENTS_DIR, file)} line ${index + 1}`] : []
    );
}

describe('the theme token layer', () => {
  it('finds component sources to scan', () => {
    expect(componentSources(COMPONENTS_DIR).length).toBeGreaterThan(100);
  });

  it('is the only reader of VS Code theme variables', () => {
    const offenders = componentSources(COMPONENTS_DIR).flatMap((file) =>
      linesMatching(file, (line) => line.includes(RAW_READ))
    );
    expect(offenders).toEqual([]);
  });

  it('tells a text colour from a border colour or a status variable', () => {
    expect(SATURATED_TEXT.test('    color: var(--schegent-color-warning);')).toBe(true);
    expect(SATURATED_TEXT.test('style="color:var(--schegent-color-active)"')).toBe(true);
    expect(SATURATED_TEXT.test('    border-color: var(--schegent-color-active);')).toBe(false);
    expect(SATURATED_TEXT.test('  --sg-status-color: var(--schegent-color-error);')).toBe(false);
    expect(SATURATED_TEXT.test('    color: var(--schegent-status-warning-text);')).toBe(false);
  });

  it('sets no text in a saturated status accent', () => {
    const offenders = componentSources(COMPONENTS_DIR).flatMap((file) =>
      linesMatching(file, (line) => SATURATED_TEXT.test(line))
    );
    expect(offenders).toEqual([]);
  });
});
