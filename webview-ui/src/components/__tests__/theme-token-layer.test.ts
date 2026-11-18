/**
 * Webview sources read colour, type and borders through the `--schegent-*`
 * tokens in `lib/theme.css`, never a `--vscode-*` variable of their own, and
 * set text in the layer's text-safe colours, never in a saturated status
 * accent. The scan covers every source under `webview-ui/src`, the entry
 * points' own stylesheets included, except the token layer itself.
 *
 * The token layer is where a VS Code variable gets its fallback, its high
 * contrast override and its text-safe mix (saturated accents never colour
 * small text). A source that reads the variable directly skips all three,
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
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_DIR = join(__dirname, '..', '..');
/** The one file that reads the VS Code variables and mixes the accents for text. */
const TOKEN_LAYER = join(SOURCE_DIR, 'lib', 'theme.css');
/** The redesign sheets, held to their own icon list by the stylesheet contract. */
const SHEET_DIR = join(SOURCE_DIR, 'lib', 'sg') + sep;
const SOURCE_EXTENSIONS = ['.svelte', '.css', '.ts'];
const RAW_READ = 'var(--vscode-';
/** A `color` declaration, not `border-color` or a custom property, that starts at an accent. */
const SATURATED_TEXT = /(?<![-\w])color\s*:\s*var\(--schegent-color-/;

function webviewSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...webviewSources(path));
      continue;
    }
    if (entry.name.endsWith('.test.ts') || path === TOKEN_LAYER) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

function isRedesignSheet(file: string): boolean {
  return file.startsWith(SHEET_DIR) && file.endsWith('.css');
}

function linesMatching(file: string, matches: (line: string) => boolean): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      matches(line) ? [`${relative(SOURCE_DIR, file)} line ${index + 1}`] : []
    );
}

describe('the theme token layer', () => {
  it('finds the webview sources to scan, the entry stylesheets among them', () => {
    const sources = webviewSources(SOURCE_DIR);
    expect(sources.length).toBeGreaterThan(250);
    expect(sources).toContain(join(SOURCE_DIR, 'dashboard', 'style.css'));
    expect(sources).toContain(join(SOURCE_DIR, 'main.ts'));
    expect(sources).not.toContain(TOKEN_LAYER);
  });

  it('is the only reader of VS Code theme variables', () => {
    const offenders = webviewSources(SOURCE_DIR).flatMap((file) =>
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

  it('sets no text in a saturated status accent outside the redesign sheets', () => {
    const offenders = webviewSources(SOURCE_DIR)
      .filter((file) => !isRedesignSheet(file))
      .flatMap((file) => linesMatching(file, (line) => SATURATED_TEXT.test(line)));
    expect(offenders).toEqual([]);
  });
});
