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

import { readFileSync } from 'node:fs';
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
