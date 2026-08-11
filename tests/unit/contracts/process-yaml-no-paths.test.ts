// Feature 084 T053 (FR-019, FR-020a, SC-016) — no filesystem location crosses
// this IPC family, in either direction.
//
// The invariant is structural, so the test is structural: it reads the contract
// module's own text, strips the prose, and inspects what is left. A field named
// `sourcePath` cannot pass by being unused, and it cannot pass by being
// documented as harmless — the check is on the declarations.
//
// The scan follows the family's re-exports into
// `src/services/process-yaml/types.ts`, because `ImportPlan`, `ImportPlanRow`,
// and `DocumentRefusal` are declared there and travel over the same boundary.
// Scanning only the contract module would leave the plan — the largest message
// in the family — unchecked.
//
// The webview never supplies a location to read or write and is never told which
// one the host used; the host opens its own dialog. That is what keeps a
// compromised or confused webview from directing a read or a write, and it is
// why the check is a denylist of *shapes* rather than of known-bad names.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const SOURCES = [
  'src/contracts/sidebar-ipc/process-yaml.ts',
  'src/services/process-yaml/types.ts',
  // Feature 085 T061 — the webview end of the same family. The host contract
  // being clean is only half the invariant: a location the webview invented and
  // sent would never appear in the host's type text. These three are the only
  // webview modules that touch the family, and they are scanned as the host's
  // are rather than trusted because they are small.
  'webview-ui/src/lib/process-yaml-ipc.ts',
  'webview-ui/src/components/ProcessImport/process-import-state.ts',
  'webview-ui/src/components/ProcessImport/process-exchange-entry.ts'
] as const;

/**
 * Feature 085 T061 — the two host seams, scanned as signatures rather than as a
 * whole file. `router-types.ts` declares every dependency the command router
 * takes, most of which have nothing to do with this family, so scanning it
 * wholesale would assert almost nothing about this one.
 */
const SEAMS = ['saveProcessYamlDocument', 'openProcessYamlDocument'] as const;

/**
 * Words that name a filesystem location, or a host handle that resolves to one.
 * Matched against member names as substrings, case-insensitively, so
 * `sourcePath`, `documentUri`, and `fileName` are all caught.
 */
const LOCATION_WORDS = [
  'path',
  'uri',
  'url',
  'file',
  'folder',
  'directory',
  'dirname',
  'location',
  'cwd',
  'workspaceroot',
  'absolute',
  'basename',
  'fspath'
] as const;

/** Host-API spellings that must not appear anywhere in the stripped text. */
const HOST_HANDLES = ['fsPath', 'workspaceFolders', 'Uri.file', 'vscode.Uri'] as const;

/** The declarations, with every comment removed. */
function typeText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every property name declared in the text, `readonly` or not, optional or not. */
function memberNames(text: string): readonly string[] {
  return [...text.matchAll(/(?:^|[{;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm)].map(
    (match) => match[1]!
  );
}

describe('Feature 084 — the Phase exchange contract names no filesystem location', () => {
  for (const source of SOURCES) {
    it(`${source} declares no location-shaped member`, () => {
      const members = memberNames(typeText(source));
      // The scan must actually find declarations; a regex that silently matched
      // nothing would pass this file forever.
      expect(members.length).toBeGreaterThan(5);

      const offenders = members.filter((name) =>
        LOCATION_WORDS.some((word) => name.toLowerCase().includes(word))
      );
      expect(offenders).toEqual([]);
    });

    it(`${source} names no host filesystem handle`, () => {
      const text = typeText(source);
      const offenders = HOST_HANDLES.filter((handle) => text.includes(handle));
      expect(offenders).toEqual([]);
    });
  }

  it('detects a location-shaped member if one were added', () => {
    // The negative control. Without it, a regex that stopped matching would make
    // every assertion above vacuously true.
    const planted = `
      export interface Planted {
        readonly resourceKind: string;
        readonly sourcePath: string;
        documentUri?: string;
      }
    `;
    const members = memberNames(planted);
    expect(members).toEqual(['resourceKind', 'sourcePath', 'documentUri']);
    expect(
      members.filter((name) => LOCATION_WORDS.some((word) => name.toLowerCase().includes(word)))
    ).toEqual(['sourcePath', 'documentUri']);
  });

  it('reads past the prose that discusses locations', () => {
    // The contract module's own header talks about filesystem locations at
    // length. Stripping comments is what lets the member scan be a denylist of
    // words without the documentation tripping it.
    const raw = readFileSync(resolve(REPO_ROOT, SOURCES[0]), 'utf8');
    expect(raw).toContain('filesystem location');
    expect(typeText(SOURCES[0])).not.toContain('filesystem location');
  });
});

describe('Feature 085 T061 — the widened surface names no location either (FR-050)', () => {
  /**
   * The declaration of one seam, from its name to the start of the next
   * top-level member. Anchored on the two-space indent, because the signature's
   * own nested members are indented further — slicing at the next `readonly`
   * would cut the declaration open at its first field and assert nothing.
   */
  function seamText(name: string): string {
    const text = typeText('src/ui/sidebar/commands/router-types.ts');
    const start = text.indexOf(`readonly ${name}?:`);
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n {2}readonly /);
    const sliced = next === -1 ? rest : rest.slice(0, next + 1);
    // The slice must actually span the signature; an anchor that stopped
    // matching would make every assertion below vacuous.
    expect(sliced).toContain('=>');
    return sliced;
  }

  it('keeps the export seam to a bare suggested name, and returns no location', () => {
    // `suggestedFileName` is the ONE location-shaped word on this path, and it
    // is deliberately not a location: the adapter decides where to anchor the
    // dialog and never reports back where the operator put the file. Asserted as
    // an exact set so a second such member cannot be added under its cover.
    const members = memberNames(seamText('saveProcessYamlDocument'));
    expect(members).toContain('suggestedFileName');
    expect(
      members.filter((name) => LOCATION_WORDS.some((word) => name.toLowerCase().includes(word)))
    ).toEqual(['suggestedFileName']);
    // A bare name, not a path: no separator may appear in what the webview sends.
    expect(seamText('saveProcessYamlDocument')).not.toMatch(/[/\\]/);
  });

  it('keeps the import seam free of any location, in both directions', () => {
    const text = seamText('openProcessYamlDocument');
    const members = memberNames(text);
    // Takes nothing at all — the webview cannot name what will be read.
    expect(text).toContain('openProcessYamlDocument?: () =>');
    expect(
      members.filter((name) => LOCATION_WORDS.some((word) => name.toLowerCase().includes(word)))
    ).toEqual([]);
    // Returns bytes and an outcome, never where they came from.
    expect([...new Set(members)].sort()).toEqual([
      'bytes',
      'message',
      'openProcessYamlDocument',
      'outcome'
    ]);
  });

  it('covers both seams, so neither can be renamed out of the scan', () => {
    const text = typeText('src/ui/sidebar/commands/router-types.ts');
    for (const seam of SEAMS) {
      expect(text).toContain(`readonly ${seam}?:`);
    }
  });

  it('reports the generic failure message, which names nothing', () => {
    // An adapter's own error text can name the location it tried to write, so
    // the handler substitutes its own. Pinned here rather than only in the
    // export suite because it is the same invariant: what reaches the operator
    // through this family carries no location.
    const handler = readFileSync(
      resolve(REPO_ROOT, 'src/ui/sidebar/commands/cmd-export-process-yaml.ts'),
      'utf8'
    );
    expect(handler).toContain("'Could not write the document.'");
  });
});

// Feature 086 T069 — the third kind widened the surface without widening the
// scan, and that is the shape of the next gap rather than a hypothetical one.
//
// Every 086 addition landed in a module `SOURCES` already lists, so the scan
// covered the new members for free. Free coverage is coverage that nobody chose,
// though: `SOURCES` is a hand-maintained list, so the invariant holds by the
// coincidence that no feature has yet put a family member in a NEW module. The
// three checks below turn that coincidence into an assertion — the list must be
// complete, the members it is credited with must actually be there, and the seam
// count must be the two the family declares.
describe('Feature 086 T069 — the scan covers the whole widened surface (FR-056, SC-018)', () => {
  /** Every module in the webview's exchange family, found rather than listed. */
  function webviewFamily(): readonly string[] {
    const dir = 'webview-ui/src/components/ProcessImport';
    const inDir = readdirSync(resolve(REPO_ROOT, dir))
      .filter((name) => name.endsWith('.ts') || name.endsWith('.svelte'))
      .map((name) => `${dir}/${name}`);
    return [...inDir, 'webview-ui/src/lib/process-yaml-ipc.ts'].sort();
  }

  it('lists every webview module in the family, so a fourth cannot arrive unscanned', () => {
    // The failure this prevents: a feature adds `ProcessWorkflowImport.svelte`
    // beside the others, declares a `sourcePath` prop on it, and every assertion
    // above still passes because the file is not in the list.
    const scanned = new Set<string>(SOURCES);
    const unscanned = webviewFamily().filter((module) => !scanned.has(module));
    expect(unscanned, 'add these to SOURCES, or state why the family excludes them').toEqual([
      // Presentational components. They are scanned below for location-shaped
      // members all the same — listed here, rather than omitted, so adding one
      // is a deliberate edit to this array.
      'webview-ui/src/components/ProcessImport/ProcessExportButton.svelte',
      'webview-ui/src/components/ProcessImport/ProcessImportPlanTable.svelte',
      'webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte',
      'webview-ui/src/components/ProcessImport/ProcessImportResultsTable.svelte'
    ]);
  });

  it.each(webviewFamily().filter((module) => module.endsWith('.svelte')))(
    '%s declares no location-shaped member either',
    (component) => {
      // `memberNames` was written for type text and finds two things in a
      // component: the props and locals it does declare with a `name:` type, and
      // the CSS properties in its `<style>` block. Both are scanned, because a
      // false positive here is a prompt to look at a real declaration and a
      // narrower regex would be one more thing to keep in step with Svelte.
      const text = typeText(component);
      expect(HOST_HANDLES.filter((handle) => text.includes(handle))).toEqual([]);
      expect(
        memberNames(text).filter((name) =>
          LOCATION_WORDS.some((word) => name.toLowerCase().includes(word))
        )
      ).toEqual([]);
    }
  );

  it('finds the members feature 086 added, so their coverage is asserted not assumed', () => {
    // `unresolvedDependency` replaced 085's `unresolvedPhaseId` (T005) and
    // `UnresolvedDependency.kind`/`resourceId` are the members it brought. If any
    // of them moved to a module outside `SOURCES`, the scan above would still be
    // green while the new declaration went unchecked.
    const members = memberNames(typeText('src/contracts/sidebar-ipc/process-yaml.ts'));
    for (const member of ['unresolvedDependency', 'kind', 'resourceId', 'inclusion']) {
      expect(members, `086's ${member} must be inside the scanned text`).toContain(member);
    }
    // 085's spelling is gone, not merely unused.
    expect(members).not.toContain('unresolvedPhaseId');
  });

  it('declares exactly the two host seams, so a third cannot be added unscanned', () => {
    // A third adapter is how a location would most plausibly re-enter: it would
    // be a new `readonly …ProcessYaml…?:` signature, and `SEAMS` would not know.
    const text = typeText('src/ui/sidebar/commands/router-types.ts');
    const declared = [...text.matchAll(/readonly\s+(\w*ProcessYaml\w*)\??\s*:/g)].map(
      (match) => match[1]!
    );
    expect([...new Set(declared)].sort()).toEqual([...SEAMS].sort());
  });
});
