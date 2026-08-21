// A dashboard route the browser suite never activates is a route no gate covers.
//
// `runs` was that route. Feature 091 added it to `DASHBOARD_ROUTES` and shipped
// its surface; the visual suite's route walk kept a hand-maintained literal of
// six entries and never named it. Nothing could report the gap, because a route
// the walk does not name is a route the walk cannot fail on — the omission
// presented as a passing suite, which is the only presentation that gets no
// attention. FR-R3-018 recorded the surface as uncovered; this is the check that
// would have said so.
//
// Both directions matter, and for different reasons. A route with no target is
// silent loss of coverage. A target naming a route that no longer exists is a
// walk step that clicks a nav button that is not there — which fails, but fails
// as a missing testid rather than as the stale list it is.
//
// What this adds, now that the type carries most of it.
//
// `ROUTE_MOUNT_TARGETS` is annotated `Record<DashboardRoute, string>` in the
// spec file, so both drift directions are already compiler errors that name the
// route. This file was written before that annotation existed, on the recorded
// premise that a typed exhaustive record was unreachable across the CJS/ESM line
// — `tests/` is Node16/CJS, `webview-ui` is `"type": "module"`, and a type-only
// import raises TS1541. That premise was wrong. `resolution-mode` resolves the
// import, measured on TypeScript 5.9.3, and the annotation is now in place. The
// note is kept rather than deleted because inheriting an unverified constraint is
// the failure mode FR-R3-021 exists to stop, and it caught this file too.
//
// Two things survive the correction. Distinctness — no two routes sharing a
// mount target — is not expressible as a type: a shared target means one route
// would pass on the other surface's landmark, and only a comparison of values can
// see it. And the source-text comparison does not depend on the type import
// surviving a tooling change; if `resolution-mode` support regresses, or the
// annotation is dropped in a refactor, the checks below still adjudicate the two
// lists. A second formulation of a gate is worth its cost when the first one's
// availability was itself a mistaken belief twice over.
//
// An unparseable list fails. A gate that cannot locate what it adjudicates has
// no verdict to deliver, and reporting "no missing routes" on the strength of
// zero routes found is the tautology FR-R3-020's review turned up in two other
// skip paths. Renaming either list should break this test loudly, not quietly
// retire it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROUTES_MODULE = resolve(REPO_ROOT, 'webview-ui', 'src', 'dashboard', 'routes.ts');
const VISUAL_SPEC = resolve(REPO_ROOT, 'tests', 'visual', 'webview.visual.spec.ts');

const ROUTES_DECLARATION = 'export const DASHBOARD_ROUTES';
const TARGETS_DECLARATION = 'const ROUTE_MOUNT_TARGETS';

/**
 * The body of a declaration, from its opening brace or bracket to the matching
 * close, by depth counting.
 *
 * The search starts after the assignment `=`, not after the identifier. The
 * first `[` following `export const DASHBOARD_ROUTES` belongs to its type
 * annotation — `readonly DashboardRoute[]` — whose brackets balance immediately
 * and yield an empty body. The first run of this gate did exactly that and
 * reported all seven routes as stale, which is the failure it is supposed to
 * report for a genuinely stale list; the check on an empty parse below is what
 * distinguished the two.
 *
 * Returns `null` rather than throwing so the caller decides what an absence
 * means — always "fail naming the file", but the message differs per list and is
 * worth stating precisely.
 */
function declarationBody(source: string, declaration: string, open: '[' | '{'): string | null {
  const declarationAt = source.indexOf(declaration);
  if (declarationAt === -1) return null;
  const assignmentAt = source.indexOf('=', declarationAt);
  if (assignmentAt === -1) return null;
  const openAt = source.indexOf(open, assignmentAt);
  if (openAt === -1) return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let index = openAt; index < source.length; index += 1) {
    const character = source[index];
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openAt + 1, index);
    }
  }
  return null;
}

/** Line comments only — neither list contains a block comment or a string
 *  literal that could hide a brace, and a parser that assumed otherwise would be
 *  claiming more than it checks. */
function withoutLineComments(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function parseRouteList(source: string): readonly string[] | null {
  const body = declarationBody(source, ROUTES_DECLARATION, '[');
  if (body === null) return null;
  return [...withoutLineComments(body).matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

function parseMountTargets(source: string): ReadonlyMap<string, string> | null {
  const body = declarationBody(source, TARGETS_DECLARATION, '{');
  if (body === null) return null;
  const entries = [...withoutLineComments(body).matchAll(/^\s*([a-z][\w-]*):\s*'([^']+)'/gm)].map(
    (match) => [match[1], match[2]] as const
  );
  return new Map(entries);
}

/** Declared routes the browser suite never activates. */
function uncoveredRoutes(
  routes: readonly string[],
  targets: ReadonlyMap<string, string>
): readonly string[] {
  return routes.filter((route) => !targets.has(route));
}

/** Mount targets keyed by a route that no longer exists. */
function staleTargets(
  routes: readonly string[],
  targets: ReadonlyMap<string, string>
): readonly string[] {
  const declared = new Set(routes);
  return [...targets.keys()].filter((route) => !declared.has(route));
}

describe('visual route coverage', () => {
  const routesSource = readFileSync(ROUTES_MODULE, 'utf8');
  const specSource = readFileSync(VISUAL_SPEC, 'utf8');

  const declaredRoutes = parseRouteList(routesSource);
  const mountTargets = parseMountTargets(specSource);

  it('locates DASHBOARD_ROUTES', () => {
    expect(
      declaredRoutes,
      `${ROUTES_DECLARATION} was not found in webview-ui/src/dashboard/routes.ts. ` +
        'If it moved or was renamed, update this gate — an unparseable list is a ' +
        'failure, never a silent pass.'
    ).not.toBeNull();
    expect(
      declaredRoutes ?? [],
      'DASHBOARD_ROUTES parsed as empty, so every comparison below would pass vacuously'
    ).not.toHaveLength(0);
  });

  it('locates the browser suite route map', () => {
    expect(
      mountTargets,
      `${TARGETS_DECLARATION} was not found in tests/visual/webview.visual.spec.ts. ` +
        'If it moved or was renamed, update this gate — an unparseable list is a ' +
        'failure, never a silent pass.'
    ).not.toBeNull();
    expect(
      [...(mountTargets?.keys() ?? [])],
      'ROUTE_MOUNT_TARGETS parsed as empty, so every comparison below would pass vacuously'
    ).not.toHaveLength(0);
  });

  it('gives every declared route a mount target', () => {
    expect(
      uncoveredRoutes(declaredRoutes ?? [], mountTargets ?? new Map()),
      'these DASHBOARD_ROUTES entries are never activated by the browser suite, so ' +
        'nothing would notice if their surfaces stopped mounting'
    ).toEqual([]);
  });

  it('names no mount target for a route that does not exist', () => {
    expect(
      staleTargets(declaredRoutes ?? [], mountTargets ?? new Map()),
      'the browser suite maps these keys to mount targets, but they are not in ' +
        'DASHBOARD_ROUTES — the walk would click a nav button that is not rendered'
    ).toEqual([]);
  });

  it('maps each route to a distinct target', () => {
    const targets = [...(mountTargets?.values() ?? [])];
    const duplicated = targets.filter((target, index) => targets.indexOf(target) !== index);
    expect(
      [...new Set(duplicated)],
      'two routes share a mount target, so one of them would pass on the other ' +
        "surface's landmark"
    ).toEqual([]);
  });

  // The four checks above pass on the tree as it stands, which says nothing
  // about whether they can fail. These drive the same functions with synthetic
  // inputs so each verdict is observed in both directions.
  describe('the gate detects what it claims to', () => {
    const REAL = ['operations', 'runs', 'history'] as const;

    it('names a route with no mount target', () => {
      const missingRuns = new Map([
        ['operations', 'queues-tier'],
        ['history', 'history-dashboard']
      ]);
      expect(uncoveredRoutes(REAL, missingRuns)).toEqual(['runs']);
    });

    it('names a mount target keyed by a route that does not exist', () => {
      const withRetired = new Map([
        ['operations', 'queues-tier'],
        ['pipeline-builder', 'pipeline-builder-root']
      ]);
      expect(staleTargets(REAL, withRetired)).toEqual(['pipeline-builder']);
    });

    it('reads the routes and targets it is pointed at', () => {
      const routes = parseRouteList(
        `${ROUTES_DECLARATION}: readonly DashboardRoute[] = ['alpha', 'beta'] as const;`
      );
      const targets = parseMountTargets(
        `${TARGETS_DECLARATION} = {\n  // a comment\n  alpha: 'a-root',\n  beta: 'b-root'\n} as const;`
      );
      expect(routes).toEqual(['alpha', 'beta']);
      expect([...(targets ?? new Map())]).toEqual([
        ['alpha', 'a-root'],
        ['beta', 'b-root']
      ]);
    });
  });

  describe('the gate itself fails on an unparseable list', () => {
    // Pointing the parsers at a source with no recognizable list. Without this,
    // the four checks above are satisfied by `null` propagating into empty
    // collections and every comparison passing on nothing.
    const NOTHING = 'export const SOMETHING_ELSE = 1;\n';

    it('returns null for a missing route list', () => {
      expect(parseRouteList(NOTHING)).toBeNull();
    });

    it('returns null for a missing mount-target map', () => {
      expect(parseMountTargets(NOTHING)).toBeNull();
    });

    it('returns null for a declaration with no closing brace', () => {
      expect(parseMountTargets(`${TARGETS_DECLARATION} = {\n  operations: 'x',\n`)).toBeNull();
    });
  });
});
