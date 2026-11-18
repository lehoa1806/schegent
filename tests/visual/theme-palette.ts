// The colours each theme is drawn in, by the visual suite that photographs it and by the
// accessibility scan that measures it.
//
// VS Code paints a theme through its `--vscode-*` variables. The webview reads them
// (`webview-ui/src/lib/theme.css`) and falls back to fixed colours where one is missing, so a
// page given only the theme's body class draws those fallbacks in every theme. Both suites
// therefore inject this sheet once the class is set, and a screenshot and a contrast scan of one
// theme look at the same colours. Decision 13 of the webview redesign review moved it here from
// `webview.visual.spec.ts`; until then the scan had checked the fallback palette three times.

/** The three themes both suites draw. The body class VS Code sets for each is the harness's. */
export type ThemeName = 'light' | 'dark' | 'high-contrast';

interface ThemePalette {
  readonly foreground: string;
  readonly background: string;
  readonly muted: string;
  readonly border: string;
  readonly input: string;
  readonly hover: string;
  readonly active: string;
  readonly focus: string;
  readonly blue: string;
  readonly green: string;
  readonly yellow: string;
  readonly red: string;
  readonly purple: string;
}

const PALETTES: Readonly<Record<ThemeName, ThemePalette>> = {
  light: {
    foreground: '#1f2328',
    background: '#ffffff',
    muted: '#59636e',
    border: '#d0d7de',
    input: '#f6f8fa',
    hover: '#eaeef2',
    active: '#dbeafe',
    focus: '#0969da',
    blue: '#0969da',
    green: '#1a7f37',
    yellow: '#9a6700',
    red: '#cf222e',
    purple: '#8250df'
  },
  dark: {
    foreground: '#e6edf3',
    background: '#0d1117',
    muted: '#8b949e',
    border: '#30363d',
    input: '#161b22',
    hover: '#21262d',
    active: '#1f3a5f',
    focus: '#58a6ff',
    blue: '#58a6ff',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#f85149',
    purple: '#bc8cff'
  },
  'high-contrast': {
    foreground: '#ffffff',
    background: '#000000',
    muted: '#ffffff',
    border: '#ffffff',
    input: '#000000',
    hover: '#1a1a1a',
    active: '#000000',
    focus: '#ffff00',
    blue: '#00ffff',
    green: '#00ff00',
    yellow: '#ffff00',
    red: '#ff5555',
    purple: '#ff7fff'
  }
};

/**
 * The sheet that paints `theme`: its `--vscode-*` variables, its page background, and no
 * animation or transition, so neither a screenshot nor a scan catches a colour mid-change.
 *
 * Each font names a face before its generic family. The editor font was once the bare
 * `monospace`, which Chromium on macOS draws in Courier but in an occasional load drew in
 * Menlo, failing the screenshot of an unchanged page; Courier is the face the baselines hold.
 *
 * Feature 184 (T046, FR-R3-141) — `--vscode-sideBarSectionHeader-background` is
 * new to this palette. `--schegent-surface-raised` reads it (`theme.css:10`) and
 * falls back to a hard `#2d2d2d` when it is missing. Every real VS Code theme
 * defines it, but this palette never did, because until the Pipelines tab moved
 * onto `workflow-flow.css` nothing photographed a raised surface — the only
 * other consumer is `App.svelte`'s `.skip-link`, which is translated off-screen
 * until focused. Left undefined, `builder-light.png` would have recorded
 * near-black Phase cards that no operator will ever see. `input` is this
 * palette's raised-surface role, the same one `--vscode-editorWidget-background`
 * takes.
 */
export function themeCss(theme: ThemeName): string {
  const palette = PALETTES[theme];
  return `
    :root {
      color-scheme: ${theme === 'light' ? 'light' : 'dark'};
      --vscode-font-family: Arial, sans-serif;
      --vscode-editor-font-family: Courier, monospace;
      --vscode-font-size: 14px;
      --vscode-foreground: ${palette.foreground};
      --vscode-descriptionForeground: ${palette.muted};
      --vscode-disabledForeground: ${palette.muted};
      --vscode-editor-background: ${palette.background};
      --vscode-sideBar-background: ${palette.background};
      --vscode-editorWidget-background: ${palette.input};
      --vscode-editorWidget-border: ${palette.border};
      --vscode-panel-border: ${palette.border};
      --vscode-sideBarSectionHeader-background: ${palette.input};
      --vscode-sideBarSectionHeader-border: ${palette.border};
      --vscode-widget-border: ${palette.border};
      --vscode-widget-shadow: rgba(0, 0, 0, 0.35);
      --vscode-input-background: ${palette.input};
      --vscode-input-foreground: ${palette.foreground};
      --vscode-input-border: ${palette.border};
      --vscode-button-background: ${palette.blue};
      --vscode-button-foreground: ${theme === 'light' ? '#ffffff' : '#000000'};
      --vscode-button-hoverBackground: ${palette.focus};
      --vscode-button-secondaryBackground: ${palette.input};
      --vscode-button-secondaryForeground: ${palette.foreground};
      --vscode-button-secondaryHoverBackground: ${palette.hover};
      --vscode-button-border: ${palette.border};
      --vscode-list-hoverBackground: ${palette.hover};
      --vscode-list-activeSelectionBackground: ${palette.active};
      --vscode-list-activeSelectionForeground: ${palette.foreground};
      --vscode-toolbar-hoverBackground: ${palette.hover};
      --vscode-focusBorder: ${palette.focus};
      --vscode-badge-background: ${palette.blue};
      --vscode-badge-foreground: ${theme === 'light' ? '#ffffff' : '#000000'};
      --vscode-charts-blue: ${palette.blue};
      --vscode-charts-green: ${palette.green};
      --vscode-charts-yellow: ${palette.yellow};
      --vscode-charts-orange: ${palette.yellow};
      --vscode-charts-red: ${palette.red};
      --vscode-charts-purple: ${palette.purple};
      --vscode-errorForeground: ${palette.red};
      --vscode-editorWarning-foreground: ${palette.yellow};
      --vscode-notificationsInfoIcon-foreground: ${palette.blue};
      --vscode-notificationsWarningIcon-foreground: ${palette.yellow};
      --vscode-testing-iconPassed: ${palette.green};
      --vscode-testing-iconFailed: ${palette.red};
      --vscode-testing-iconQueued: ${palette.yellow};
      --vscode-textBlockQuote-background: ${palette.input};
      --vscode-textCodeBlock-background: ${palette.input};
      --vscode-textLink-foreground: ${palette.blue};
      --vscode-editorHoverWidget-background: ${palette.input};
      --vscode-editorHoverWidget-foreground: ${palette.foreground};
      --vscode-editorHoverWidget-border: ${palette.border};
      --vscode-inputValidation-errorBackground: ${palette.input};
      --vscode-inputValidation-errorBorder: ${palette.red};
      --vscode-inputValidation-infoBackground: ${palette.input};
      --vscode-inputValidation-warningBackground: ${palette.input};
      --vscode-inputValidation-warningBorder: ${palette.yellow};
      --vscode-inputValidation-warningForeground: ${palette.yellow};
    }
    html, body { background: ${palette.background} !important; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
  `;
}
