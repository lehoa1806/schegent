/**
 * Contract for the redesign stylesheets in `src/lib/sg/`.
 *
 * The sheets carry the component rules of the two redesign mockups,
 * `schegent_redesign_surfaces.html` and `workflow_builder_redesign.html`, rewritten onto the
 * `--schegent-*` tokens in `theme.css`. This file pins the contract the sheets keep rather than
 * their individual rules: every selector is anchored to the opt-in `.sg` root, colour comes from
 * tokens only, the two entry points load the shared sheets ahead of the component tree, and the
 * status text the tokens produce stays at WCAG AA in both mockup palettes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = readonly [number, number, number];
type StatusSource = 'active' | 'completed' | 'warning' | 'error' | 'workflow';
type TextSurface = 'bg' | 'shell' | 'surface' | 'input' | 'hover';

interface Declaration {
  readonly property: string;
  readonly value: string;
}

interface StyleRule {
  readonly selectors: readonly string[];
  readonly declarations: readonly Declaration[];
}

interface Palette {
  readonly name: string;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly shell: Rgb;
  readonly surface: Rgb;
  readonly input: Rgb;
  readonly hover: Rgb;
  readonly selection: Rgb;
  readonly active: Rgb;
  readonly completed: Rgb;
  readonly warning: Rgb;
  readonly error: Rgb;
  readonly workflow: Rgb;
}

const LIB_DIR = join(__dirname, '..');
const SOURCE_DIR = join(LIB_DIR, '..');
const THEME_FILE = join(LIB_DIR, 'theme.css');
const SHEET_DIR = join(LIB_DIR, 'sg');

const SIDEBAR_SHEETS = ['sg-core.css', 'sg-sidebar.css'];
const DASHBOARD_SHEETS = ['sg-core.css', 'sg-pages.css'];
/** Imported by the root component of the route that uses them, never by an entry point. */
const ROUTE_SHEETS = ['sg-builder.css', 'sg-metrics.css', 'sg-run-detail.css', 'sg-settings.css'];
const ALL_SHEETS = [...new Set([...SIDEBAR_SHEETS, ...DASHBOARD_SHEETS, ...ROUTE_SHEETS])].sort();

const ENTRY_POINTS = [
  { file: 'main.ts', sheetDir: './lib/sg', sheets: SIDEBAR_SHEETS },
  { file: 'dashboard/main.ts', sheetDir: '../lib/sg', sheets: DASHBOARD_SHEETS }
];
const APP_IMPORT = "import App from './App.svelte';";
const SHEET_IMPORT = /^import '(?:\.\.?\/)+lib\/sg\/([\w-]+\.css)';$/gm;

/** A selector starts at the root class: on the root itself (`.sg.dash`) or below it. */
const SCOPE_ROOT = /^\.sg(?![\w-])/;
const NESTING_AT_RULES = ['@media', '@supports'];
const PROPERTY_NAME = /^-{0,2}[a-z][a-z0-9-]*$/;
const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;
const TOKEN_REFERENCE = /var\(\s*(--[\w-]+)/g;
const SATURATED_TEXT = /^var\(--schegent-color-/;
const FOREGROUND_MIX = /(\d+)%, var\(--schegent-fg\)/;

/**
 * The only rules that may set `color` to a saturated status colour. Each one paints an icon, and
 * a text label beside it carries the meaning.
 */
const ICON_CONTAINERS: readonly string[] = [
  '.sg .k-phase',
  '.sg .k-workflow',
  '.sg .k-logic',
  '.sg .brand svg',
  '.sg .attn .ic',
  '.sg .attn.warn .ic'
];

const WCAG_AA_TEXT = 4.5;
const DEFAULT_FONT_SIZE_PX = 13;
const MOCKUP_TYPE_RAMP_PX = {
  micro: 10,
  caption: 11,
  secondary: 12,
  body: 13,
  subheading: 14,
  title: 15,
  heading: 18,
  display: 24
};

/** What the product ships at `:root`, and what the mockups use, which `.sg` scopes in. */
const RESCOPED_TOKENS = [
  { token: '--schegent-radius', product: '6px', redesign: '8px' },
  { token: '--schegent-radius-sm', product: '4px', redesign: '5px' },
  { token: '--schegent-control-height', product: '32px', redesign: '28px' },
  { token: '--schegent-control-height-compact', product: '28px', redesign: '24px' }
];

const STATUS_TEXT: readonly { readonly token: string; readonly source: StatusSource }[] = [
  { token: '--schegent-status-active-text', source: 'active' },
  { token: '--schegent-status-completed-text', source: 'completed' },
  { token: '--schegent-status-warning-text', source: 'warning' },
  { token: '--schegent-error-text', source: 'error' },
  { token: '--schegent-workflow-text', source: 'workflow' }
];
const TEXT_SURFACES: readonly TextSurface[] = ['bg', 'shell', 'surface', 'input', 'hover'];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16)
  ) as unknown as Rgb;
}

function mix(foreground: Rgb, background: Rgb, foregroundWeight: number): Rgb {
  return foreground.map((channel, index) =>
    Math.round(channel * foregroundWeight + background[index] * (1 - foregroundWeight))
  ) as unknown as Rgb;
}

function luminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(a: Rgb, b: Rgb): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Splits on a separator, but not inside `:is(...)`, `:not(...)`, `var(...)` or `color-mix(...)`. */
function splitOutsideParens(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function bracesBalance(css: string): boolean {
  let depth = 0;
  for (const char of css) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function parseDeclarations(body: string): Declaration[] {
  return splitOutsideParens(body, ';').map((entry) => {
    const colon = entry.indexOf(':');
    if (colon === -1) return { property: '', value: entry };
    return {
      property: entry.slice(0, colon).trim(),
      value: entry
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, ' ')
    };
  });
}

/** Style rules in source order. Rules inside `@media` are included; `@keyframes` is skipped. */
function parseRules(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) break;
    const close = matchingBrace(css, open);
    if (close === -1) break;
    const prelude = css.slice(cursor, open).trim();
    const body = css.slice(open + 1, close);
    cursor = close + 1;
    if (NESTING_AT_RULES.some((name) => prelude.startsWith(name))) {
      rules.push(...parseRules(body));
      continue;
    }
    if (prelude.startsWith('@')) continue;
    rules.push({
      selectors: splitOutsideParens(prelude, ','),
      declarations: parseDeclarations(body)
    });
  }
  return rules;
}

/** The value that wins in source order: the last declaration under that exact selector. */
function lastValue(
  rules: readonly StyleRule[],
  selector: string,
  property: string
): string | undefined {
  return rules
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => rule.declarations)
    .filter((declaration) => declaration.property === property)
    .at(-1)?.value;
}

function hasDeclaration(rule: StyleRule, property: string, value: string): boolean {
  return rule.declarations.some(
    (declaration) => declaration.property === property && declaration.value === value
  );
}

function customProperties(rules: readonly StyleRule[]): string[] {
  return rules
    .flatMap((rule) => rule.declarations)
    .map((declaration) => declaration.property)
    .filter((property) => property.startsWith('--'));
}

function referencedProperties(css: string): string[] {
  return [...css.matchAll(TOKEN_REFERENCE)].map((match) => match[1]);
}

/**
 * How much of the saturated colour a status-text token keeps. Throws when the token is not a mix
 * toward the foreground, so that a contrast check cannot pass on a number nothing produced.
 */
function saturatedShare(token: string, value: string | undefined): number {
  const percent = FOREGROUND_MIX.exec(value ?? '')?.[1];
  if (percent === undefined) {
    throw new Error(`${token} is not a color-mix toward --schegent-fg`);
  }
  return Number(percent) / 100;
}

function pxAtDefaultFontSize(value: string | undefined): number {
  const fraction = /^calc\((\d+)rem \/ (\d+)\)$/.exec(value ?? '');
  if (fraction !== null) {
    return (Number(fraction[1]) / Number(fraction[2])) * DEFAULT_FONT_SIZE_PX;
  }
  const whole = /^([\d.]+)rem$/.exec(value ?? '');
  if (whole !== null) return Number(whole[1]) * DEFAULT_FONT_SIZE_PX;
  return Number.NaN;
}

function readSheet(sheet: string): string {
  return stripComments(readFileSync(join(SHEET_DIR, sheet), 'utf8'));
}

function sheetRules(sheet: string): StyleRule[] {
  return parseRules(readSheet(sheet));
}

function themeRules(): StyleRule[] {
  return parseRules(stripComments(readFileSync(THEME_FILE, 'utf8')));
}

/** The colours the two mockups draw with. Their dark and light blocks agree with each other. */
const MOCKUP_PALETTES: readonly Palette[] = [
  {
    name: 'dark',
    fg: rgb('#cccccc'),
    bg: rgb('#1e1e1e'),
    shell: rgb('#181818'),
    surface: rgb('#252526'),
    input: rgb('#313131'),
    hover: rgb('#2a2d2e'),
    selection: rgb('#04395e'),
    active: rgb('#3794ff'),
    completed: rgb('#89d185'),
    warning: rgb('#cca700'),
    error: rgb('#f14c4c'),
    workflow: rgb('#b180d7')
  },
  {
    name: 'light',
    fg: rgb('#3b3b3b'),
    bg: rgb('#ffffff'),
    shell: rgb('#f8f8f8'),
    surface: rgb('#f3f3f3'),
    input: rgb('#ffffff'),
    hover: rgb('#f0f0f0'),
    selection: rgb('#cce4f7'),
    active: rgb('#1a85ff'),
    completed: rgb('#388a34'),
    warning: rgb('#8a6d00'),
    error: rgb('#c72e0f'),
    workflow: rgb('#652d90')
  }
];

describe('redesign stylesheet set', () => {
  it('holds exactly the sheets this contract names', () => {
    expect(readdirSync(SHEET_DIR).sort()).toEqual(ALL_SHEETS);
  });

  it('gives no sheet a name the build would route into dashboard.css', () => {
    // vite.config.ts emits a CSS asset as dashboard.css when its source name contains
    // "dashboard", and the bundle-size gate budgets that file by name.
    expect(ALL_SHEETS.filter((sheet) => sheet.includes('dashboard'))).toEqual([]);
  });

  it('references only custom properties that theme.css or a sheet defines', () => {
    const defined = new Set([
      ...customProperties(themeRules()),
      ...ALL_SHEETS.flatMap((sheet) => customProperties(sheetRules(sheet)))
    ]);
    const unknown = ALL_SHEETS.flatMap((sheet) =>
      [...new Set(referencedProperties(readSheet(sheet)))]
        .filter((property) => !defined.has(property))
        .map((property) => `${sheet}: ${property}`)
    );
    expect(unknown).toEqual([]);
  });

  it('pairs the selection background with the selection foreground', () => {
    const selected = ALL_SHEETS.flatMap((sheet) => sheetRules(sheet)).filter((rule) =>
      hasDeclaration(rule, 'background', 'var(--schegent-selection-bg)')
    );
    expect(selected.length).toBeGreaterThan(0);
    const unpaired = selected
      .filter((rule) => !hasDeclaration(rule, 'color', 'var(--schegent-selection-fg)'))
      .map((rule) => rule.selectors.join(', '));
    expect(unpaired).toEqual([]);
  });

  it('sets text in a saturated status colour only on icon containers', () => {
    const saturated = ALL_SHEETS.flatMap((sheet) => sheetRules(sheet))
      .filter((rule) =>
        rule.declarations.some(
          (declaration) =>
            declaration.property === 'color' && SATURATED_TEXT.test(declaration.value)
        )
      )
      .flatMap((rule) => rule.selectors);
    expect(saturated.filter((selector) => !ICON_CONTAINERS.includes(selector))).toEqual([]);
    expect(ICON_CONTAINERS.filter((selector) => !saturated.includes(selector))).toEqual([]);
  });

  it('uses !important only to keep [hidden] hidden', () => {
    const important = ALL_SHEETS.flatMap((sheet) =>
      sheetRules(sheet)
        .filter((rule) =>
          rule.declarations.some((declaration) => declaration.value.includes('!important'))
        )
        .map((rule) => `${sheet}: ${rule.selectors.join(', ')}`)
    );
    expect(important).toEqual(['sg-core.css: .sg [hidden]']);
  });

  it('centres a button label, as a native button does', () => {
    // The mockups' buttons are only as wide as their label, so the mockup rule leaves the label
    // at the start. A container that stretches a button, such as the builder inspector's column
    // of port buttons, would otherwise draw the label against the left edge.
    expect(lastValue(sheetRules('sg-core.css'), '.sg .btn', 'justify-content')).toBe('center');
  });

  it('outlines a ghost button in a high contrast theme alone', () => {
    // Finding 121 of the webview redesign review. Both mockups draw a ghost button with no border,
    // and a normal theme should too. A high contrast theme outlines every control in its contrast
    // border, a colour VS Code defines in those themes alone, so the ghost button takes it there.
    expect(lastValue(sheetRules('sg-core.css'), '.sg .btn-ghost', 'border-color')).toBe(
      'var(--schegent-contrast-border)'
    );
    expect(lastValue(themeRules(), ':root', '--schegent-contrast-border')).toBe(
      'var(--vscode-contrastBorder, transparent)'
    );
  });
});

describe.each(ALL_SHEETS)('%s', (sheet) => {
  it('parses into well-formed rules', () => {
    const css = readSheet(sheet);
    const rules = parseRules(css);
    expect(bracesBalance(css)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    const malformed = rules.flatMap((rule) =>
      rule.declarations
        .filter(
          (declaration) =>
            !PROPERTY_NAME.test(declaration.property) ||
            declaration.value === '' ||
            declaration.value.includes(':')
        )
        .map((declaration) => `${rule.selectors.join(', ')} { ${declaration.property} }`)
    );
    expect(malformed).toEqual([]);
  });

  it('anchors every selector to the .sg root', () => {
    const unscoped = sheetRules(sheet)
      .flatMap((rule) => rule.selectors)
      .filter((selector) => !SCOPE_ROOT.test(selector));
    expect(unscoped).toEqual([]);
  });

  it('takes every colour from a --schegent-* token', () => {
    const css = readSheet(sheet);
    expect(css.match(RAW_COLOR) ?? []).toEqual([]);
    expect(css).not.toContain('--vscode-');
  });
});

describe.each(ENTRY_POINTS)('entry point $file', ({ file, sheetDir, sheets }) => {
  it('imports its shared sheets, and no route sheet, ahead of the component tree', () => {
    const source = readFileSync(join(SOURCE_DIR, file), 'utf8');
    const imported = [...source.matchAll(SHEET_IMPORT)].map((match) => match[1]);
    expect(imported).toEqual(sheets);

    // Component styles and these sheets tie on specificity, so the later one wins. Importing
    // the sheets before the component tree lets a component override a shared rule.
    const appImport = source.indexOf(APP_IMPORT);
    expect(appImport).toBeGreaterThan(-1);
    for (const sheet of sheets) {
      const sheetImport = source.indexOf(`import '${sheetDir}/${sheet}';`);
      expect(sheetImport).toBeGreaterThan(-1);
      expect(sheetImport).toBeLessThan(appImport);
    }
  });
});

describe('redesign tokens in theme.css', () => {
  it.each(RESCOPED_TOKENS)(
    'keeps $token at $product for the product and sets $redesign under .sg',
    ({ token, product, redesign }) => {
      const theme = themeRules();
      expect(lastValue(theme, ':root', token)).toBe(product);
      expect(lastValue(theme, '.sg', token)).toBe(redesign);
    }
  );

  it.each(Object.entries(MOCKUP_TYPE_RAMP_PX))(
    'sets --schegent-text-%s to %dpx at the default font size under .sg',
    (step, px) => {
      const value = lastValue(themeRules(), '.sg', `--schegent-text-${step}`);
      expect(pxAtDefaultFontSize(value)).toBeCloseTo(px, 6);
    }
  );

  it('scopes no token to .sg that no sheet uses', () => {
    const scoped = customProperties(
      themeRules().filter((rule) => rule.selectors.includes('.sg'))
    );
    expect(scoped.length).toBeGreaterThan(0);
    const referenced = new Set(ALL_SHEETS.flatMap((sheet) => referencedProperties(readSheet(sheet))));
    expect(scoped.filter((property) => !referenced.has(property))).toEqual([]);
  });

  it('aliases the error status text to the contrast-safe error token', () => {
    const value = lastValue(themeRules(), ':root', '--schegent-status-error-text');
    expect(value).toBe('var(--schegent-error-text)');
  });

  it('falls back to the foreground when the theme sets no selection foreground', () => {
    const theme = themeRules();
    expect(lastValue(theme, ':root', '--schegent-selection-fg')).toBe(
      'var(--vscode-list-activeSelectionForeground, var(--schegent-fg))'
    );
    expect(lastValue(theme, ':root', '--schegent-selection-bg')).toMatch(
      /^var\(--vscode-list-activeSelectionBackground, /
    );
  });
});

describe.each(MOCKUP_PALETTES)('contrast in the $name mockup palette', (palette) => {
  it('keeps status text at WCAG AA on every surface it is drawn on', () => {
    const theme = themeRules();
    const failures: string[] = [];
    for (const status of STATUS_TEXT) {
      const share = saturatedShare(status.token, lastValue(theme, ':root', status.token));
      const text = mix(palette[status.source], palette.fg, share);
      for (const surface of TEXT_SURFACES) {
        const ratio = contrast(text, palette[surface]);
        // Written as a negation so that a ratio that is not a number counts as a failure.
        if (!(ratio >= WCAG_AA_TEXT)) {
          failures.push(`${status.token} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the navigation count badge at WCAG AA', () => {
    const pages = sheetRules('sg-pages.css');
    expect(lastValue(pages, '.sg .nav .count', 'background')).toBe('var(--schegent-color-error)');
    expect(lastValue(pages, '.sg .nav .count', 'color')).toBe('var(--schegent-bg)');
    expect(contrast(palette.bg, palette.error)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('keeps foreground text on the selection background at WCAG AA', () => {
    expect(contrast(palette.fg, palette.selection)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });
});
