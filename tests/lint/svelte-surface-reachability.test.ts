// Feature 091 T021 (US2, FR-019 to FR-027) — a shipped view no entry point can
// reach is dead code that looks alive.
//
// It type-checks, its own tests pass, the LOC budget covers it, and no operator
// can ever see it. `WorkflowRun.svelte` and `RunLauncher.svelte` sat in exactly
// that state through two features: complete, tested, imported by nothing outside
// `__tests__/`. Nothing in the suite could say so, because every check in it
// asks whether a component is correct and none asks whether it is connected.
//
// This walks the import graph from the two shipped bundle entry points and fails
// on any `.svelte` file it cannot arrive at. The allowlist below is the escape
// hatch, and it is a map rather than a set so FR-024's recorded reason is a
// value the failure message can print — a comment would be invisible at exactly
// the moment someone needs it.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');

/**
 * Both shipped bundles (FR-021). A named constant rather than a glob: a third
 * bundle added later must be added here deliberately, because a walker that
 * silently misses an entry root reports its whole subtree as unreachable and
 * teaches the next reader to widen the allowlist instead.
 */
const ENTRY_POINTS: readonly string[] = [
  join(WEBVIEW_SRC, 'main.ts'),
  join(WEBVIEW_SRC, 'dashboard', 'main.ts')
];

/**
 * A component reachable only from a dynamic import is still reachable (FR-022),
 * and this is the positive control for it: every lazily-loaded dashboard route
 * arrives this way. A walker that resolves `from '…'` but drops `import('…')`
 * would pass the main assertion — every lazy route would simply look
 * unreachable and get allowlisted — so the control names one such leaf and
 * requires it in the reachable set.
 */
const DYNAMIC_ONLY_LEAF = 'webview-ui/src/components/RunsSurface.svelte';

/** FR-027 — the two components this feature exists to mount. */
const MUST_NOT_BE_ALLOWLISTED: readonly string[] = [
  'webview-ui/src/components/WorkflowRun/WorkflowRun.svelte',
  'webview-ui/src/components/RunLauncher/RunLauncher.svelte'
];

/**
 * FR-024 — path to the reason it is not mounted. FR-040 forbids deleting these,
 * so a recorded reason is the only compliant disposition.
 *
 * Removing an entry is the expected direction of travel: A3 below makes
 * mounting a component and forgetting its entry a failure, so the list shrinks
 * under pressure and grows only deliberately.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'webview-ui/src/components/AuditTail.svelte',
    "Superseded by the System route's audit list. Retained for its test coverage."
  ],
  [
    'webview-ui/src/components/ControlPanel.svelte',
    "Superseded by the queue pane's inline controls."
  ],
  [
    'webview-ui/src/components/LiveActivityHeader.svelte',
    "Superseded by RunDetailTier's header."
  ],
  [
    'webview-ui/src/components/MonitorPill.svelte',
    'Superseded by the status projection in the activity pane. Retained for its tests.'
  ],
  [
    'webview-ui/src/components/StatusHeader.svelte',
    'Superseded by the sidebar brand header in App.svelte.'
  ],
  [
    'webview-ui/src/components/PhaseTracker.svelte',
    "Superseded by RunDetailTier's phase list."
  ],
  [
    'webview-ui/src/components/PhaseTile.svelte',
    'Only importer is PhaseTracker, itself unreachable.'
  ],
  ['webview-ui/src/components/QueueList.svelte', 'Superseded by QueuesTier.'],
  [
    'webview-ui/src/components/QueueGlobalActions.svelte',
    'Only importer is QueueList. Already documented as an orphan in destructive-actions.lint.test.ts.'
  ],
  [
    'webview-ui/src/components/hover-text/HoverText.svelte',
    'Superseded by the hover-text-anchor-action directive and HoverTextPortal.'
  ]
]);

/**
 * FR-023 — a test file is not an entry point, and a component reachable only
 * from a test is not reachable. Skipped as both a node and an edge, which is
 * why `AuditTail.svelte` stays unreachable despite its own test importing it,
 * and why `__tests__/HoverTextHarness.svelte` is not counted at all.
 */
function isTestPath(path: string): boolean {
  return path.split(/[\\/]/).includes('__tests__');
}

function collectSvelteFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSvelteFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.svelte')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The four specifier shapes that carry a real edge in this codebase. Bare
 * side-effect imports count because they can pull a module — and transitively a
 * component — into a bundle; `export … from` counts because it is an import
 * edge wearing a different keyword.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;}])(?:import|export)\s[^'"();]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    // Each RegExp is stateful (`g`); reset before reuse across files.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

/**
 * Extension-less specifiers resolve by trying `.ts`, then `.svelte.ts`, then
 * `.svelte`, then `/index.ts` — the order the bundler uses, and the order that
 * matters: `lib/foo` next to both `foo.ts` and `foo.svelte` must resolve to the
 * module the import actually gets.
 */
const RESOLUTION_SUFFIXES: readonly string[] = ['.ts', '.svelte.ts', '.svelte', '/index.ts'];

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import — nothing local to walk
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Breadth-first from the entry roots over both `.ts` and `.svelte` (FR-020).
 *
 * Traversing `.ts` is mandatory, not thoroughness for its own sake: two real
 * edges in this codebase are TS-mediated — `lib/use-confirm.ts` reaches
 * `ConfirmDialog.svelte`, and `hover-text-anchor-action.ts` reaches
 * `HoverTextPortal.svelte`. A `.svelte`-only walker reports both as unreachable
 * on day one.
 */
function walkReachable(): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = ENTRY_POINTS.filter((entry) => existsSync(entry));

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current) || isTestPath(current)) continue;
    seen.add(current);

    if (!/\.(ts|svelte)$/.test(current)) continue;
    const source = readFileSync(current, 'utf8');
    for (const specifier of specifiersIn(source)) {
      const target = resolveSpecifier(current, specifier);
      if (target !== null && !seen.has(target) && !isTestPath(target)) queue.push(target);
    }
  }
  return seen;
}

const reachable = walkReachable();
const components = collectSvelteFiles(WEBVIEW_SRC);
const rel = (path: string): string => relative(REPO_ROOT, path).split('\\').join('/');
const unreachable = components.filter((path) => !reachable.has(path)).map(rel);

describe('Feature 091 — every shipped Svelte view is reachable from an entry point', () => {
  it('A1: no component outside the allowlist is unreachable', () => {
    const offenders = unreachable.filter((path) => !ALLOWLIST.has(path));
    expect(
      offenders,
      `No shipped entry point imports these components, so no operator can reach them. ` +
        `Mount each one, or add it to ALLOWLIST with a recorded reason (FR-024):\n` +
        offenders.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A2: every allowlist entry still exists on disk', () => {
    const missing = [...ALLOWLIST.keys()].filter(
      (path) => !existsSync(resolve(REPO_ROOT, path))
    );
    expect(
      missing,
      `These allowlist entries name files that no longer exist. Remove the entries:\n` +
        missing.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A3: every allowlist entry is still unreachable', () => {
    // The more insidious direction: a component got mounted while its entry
    // stayed, so the entry now excuses nothing and the next genuinely
    // unreachable file inherits a stale excuse.
    const nowReachable = [...ALLOWLIST.keys()].filter((path) => !unreachable.includes(path));
    expect(
      nowReachable,
      `These components are now reachable, so their allowlist entries excuse nothing. ` +
        `Remove them from ALLOWLIST:\n` +
        nowReachable.map((path) => `  - ${path} (${ALLOWLIST.get(path)})`).join('\n')
    ).toEqual([]);
  });

  it('A4: the walk examined components and followed a dynamic import', () => {
    // Two halves, each failing a different broken walker: a count of zero fails
    // a collector that silently matched nothing; the dynamic-only leaf fails a
    // walker that resolves static imports and drops `import('…')`.
    expect(components.length).toBeGreaterThan(0);
    expect(
      reachable.has(resolve(REPO_ROOT, DYNAMIC_ONLY_LEAF)),
      `${DYNAMIC_ONLY_LEAF} is reached only through a dynamic import. ` +
        `If it reads as unreachable, the walker stopped following import('…').`
    ).toBe(true);
  });

  it('A5: neither component this feature mounts is allowlisted', () => {
    // The cheapest way to make this check pass is to allowlist the two views it
    // was written to mount. FR-027 forbids it; this is the forbidding.
    const excused = MUST_NOT_BE_ALLOWLISTED.filter((path) => ALLOWLIST.has(path));
    expect(
      excused,
      `FR-027: these must be mounted, not excused:\n` +
        excused.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });
});
