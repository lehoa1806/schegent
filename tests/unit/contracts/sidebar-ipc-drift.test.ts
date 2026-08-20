import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Authoritative from '../../../src/contracts/sidebar-ipc';
import * as HostShim from '../../../src/ui/sidebar/messages';

// Drift guard for FR-024 / US4.
//
// The host shim is statically imported above so module identity can be
// asserted via `===`. The webview shim lives in a package configured with
// `"type": "module"` + bundler resolution, which cannot be statically
// imported from the host's Node16/CJS TS context (TS1479). Module identity
// for the webview shim is guaranteed at the source-text level: it is a
// single `export *` re-export of the authoritative module. We assert that
// invariant by reading the shim's source. If a future contributor adds a
// local declaration, fork in a divergent type, or repoints the path, this
// test fails.

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('sidebar-ipc drift guard (FR-024)', () => {
  it('host shim re-exports CMD_CANCEL identical to authoritative module', () => {
    expect(HostShim.CMD_CANCEL).toBe(Authoritative.CMD_CANCEL);
    expect(HostShim.CMD_CANCEL).toBe('CMD_CANCEL');
  });

  it('host shim shares SCHEMA_VERSION with authoritative module', () => {
    expect(HostShim.SCHEMA_VERSION).toBe(Authoritative.SCHEMA_VERSION);
  });

  it('host shim exports the same COMMAND_GUARDS object as authoritative module', () => {
    expect(HostShim.COMMAND_GUARDS).toBe(Authoritative.COMMAND_GUARDS);
  });

  it('every COMMAND_TYPES literal has a guard in COMMAND_GUARDS', () => {
    for (const literal of Authoritative.COMMAND_TYPES) {
      expect(Authoritative.COMMAND_GUARDS).toHaveProperty(literal);
      const guard = Authoritative.COMMAND_GUARDS[literal];
      expect(typeof guard).toBe('function');
    }
  });

  it('COMMAND_GUARDS keyset equals COMMAND_TYPES (no extra/missing keys)', () => {
    const guardKeys = Object.keys(Authoritative.COMMAND_GUARDS).sort();
    const literals = [...Authoritative.COMMAND_TYPES].sort();
    expect(guardKeys).toEqual(literals);
  });

  it('discriminated union is exhaustive — each literal has a runtime guard that accepts a minimal command of that type', () => {
    // Most guards accept the bare `{ type, correlationId }` envelope. A
    // small number require a non-empty payload because they carry
    // operator input — register their minimal valid fixtures here. The
    // drift contract is still: "every literal has a runtime guard that
    // accepts SOME minimal command of that type", not "the bare envelope
    // is always sufficient".
    const PAYLOAD_REQUIRED_FIXTURES: Partial<
      Record<(typeof Authoritative.COMMAND_TYPES)[number], Record<string, unknown>>
    > = {
      [Authoritative.CMD_SET_CONFIRM_SUPPRESSION]: {
        actionKey: 'queue.clean-all',
        suppressed: true
      },
      // ReadMetricsCommand.payload is required at the type level (see its
      // field comment) even though every ReadMetricsRequest field is
      // itself optional, so `{}` is the minimal valid payload — a bare
      // envelope with no `payload` key at all is correctly rejected.
      [Authoritative.CMD_READ_METRICS]: {},
      [Authoritative.CMD_PING_BACKEND]: { runner: 'claude' },
      // Feature 084/085 — the Phase arm of the export union is the minimal
      // one: `resourceKind` discriminates, `resourceId` names what to resolve
      // from the effective catalog, and there is no inclusion choice to make.
      [Authoritative.CMD_EXPORT_PROCESS_YAML]: {
        resourceKind: 'phase',
        resourceId: 'specify'
      },
      // Feature 085 — preflight carries NOTHING (FR-020a, FR-055a). `{}` is
      // the whole payload; the kind 084 sent here is gone, because the host
      // dispatches on the `kind:` the document declares.
      [Authoritative.CMD_PREFLIGHT_PROCESS_YAML]: {},
      // Feature 087 — the minimal launch is a Pipeline that asks for nothing:
      // an id plus the three collections, present and empty. The guard checks
      // shape only and deliberately stops there, because a request whose
      // collections are empty may still be perfectly legal (a Pipeline whose
      // every input port is Phase-fed) or refused for a dozen reasons at once
      // — and reporting every failing field at once (FR-013) is something a
      // boolean predicate cannot do. `validateRunRequest()` owns that.
      [Authoritative.CMD_LAUNCH_PIPELINE]: {
        request: {
          pipelineId: 'default',
          inputs: [],
          supplemental: [],
          outputs: []
        }
      },
      // Feature 088 — a launch adds the two identifiers a connected run needs
      // that a Pipeline run does not: which Workflow, and which of its allowed
      // starting nodes (FR-010, FR-011). Whether the node really is a starting
      // node, and whether the request names that node's Pipeline, are gates 3
      // and 3a — the predicate sees a `RunRequest` and not the graph, so it
      // cannot reach either, and deliberately does not try.
      [Authoritative.CMD_LAUNCH_WORKFLOW]: {
        workflowId: 'release',
        startNodeId: 'n-triage',
        request: {
          pipelineId: 'triage-flow',
          inputs: [],
          supplemental: [],
          outputs: []
        }
      },
      // Feature 088 — `expectedRevision: 0` is the minimal *shape*, not a
      // legal continuation: a stored run's revision starts at 1, so this value
      // is refused by gate 2 at run time. The predicate admits it because
      // rejecting it would be the guard second-guessing the compare-and-set,
      // and a caller that echoes back what it was given is exactly what
      // FR-046 asks for.
      [Authoritative.CMD_CONTINUE_WORKFLOW]: {
        connectedRunId: 'connected-run-1',
        expectedRevision: 0,
        nodeId: 'n-ship',
        request: {
          pipelineId: 'ship-flow',
          inputs: [],
          supplemental: [],
          outputs: []
        }
      },
      // Feature 096 — `models` is the only required field. `expectedRevision`
      // and `mutation` are the import-confirm call site's fields (contracts/
      // model-catalog-exchange.md §4); the existing manual add/remove call
      // site's minimal command correctly omits both.
      [Authoritative.CMD_SAVE_MODELS]: { models: {} },
      // Feature 100 — the six lifecycle commands. All five per-definition ones
      // carry the same three control fields; only what they add differs. `body:
      // null` is the minimal body for a draft write, because the guard checks the
      // key's presence and never its shape: the store holds a body verbatim (099
      // FR-010) and a half-finished edit is exactly what a draft exists for.
      [Authoritative.CMD_SAVE_DEFINITION_DRAFT]: {
        kind: 'phase',
        id: 'specify',
        expectedDraftVersion: 'no-draft',
        body: null
      },
      [Authoritative.CMD_PUBLISH_DEFINITION]: {
        kind: 'phase',
        id: 'specify',
        expectedDraftVersion: 'v1'
      },
      [Authoritative.CMD_DEACTIVATE_DEFINITION]: {
        kind: 'phase',
        id: 'specify',
        expectedDraftVersion: 'v1'
      },
      [Authoritative.CMD_DISCARD_DEFINITION_DRAFT]: {
        kind: 'phase',
        id: 'specify',
        expectedDraftVersion: 'v1'
      },
      [Authoritative.CMD_RESTORE_DEFINITION_VERSION]: {
        kind: 'phase',
        id: 'specify',
        expectedDraftVersion: 'v1',
        fromVersionId: 'v1'
      },
      // The one envelope that still addresses a whole kind, because a package is
      // one imported document published in kind order (FR-035). The guard admits
      // an empty `layers` as a matter of shape; the ingress validator refuses it,
      // so the fixture is a document both would accept.
      [Authoritative.CMD_PUBLISH_PACKAGE]: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: 'rev-phase-0',
            definitions: [{ id: 'specify', body: null }]
          }
        ]
      }
    };
    for (const literal of Authoritative.COMMAND_TYPES) {
      const guard = Authoritative.COMMAND_GUARDS[literal];
      const payload = PAYLOAD_REQUIRED_FIXTURES[literal];
      const minimal = payload === undefined
        ? { type: literal, correlationId: 'c-test' }
        : { type: literal, correlationId: 'c-test', payload };
      expect(guard(minimal), `guard for ${literal} must accept a minimal fixture`).toBe(true);
      expect(guard({ type: 'NEVER_VALID_LITERAL' }), `guard for ${literal} must reject foreign literal`).toBe(false);
    }
  });

  it('rejects null, undefined, primitives, and objects without a type discriminator', () => {
    for (const literal of Authoritative.COMMAND_TYPES) {
      const guard = Authoritative.COMMAND_GUARDS[literal];
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard('string')).toBe(false);
      expect(guard(42)).toBe(false);
      expect(guard({})).toBe(false);
      expect(guard({ type: undefined })).toBe(false);
    }
  });

  // Feature 085 (T068, research R8) — the export request stopped being a flat
  // record and became a discriminated union, and the preflight request lost its
  // last field. Both are boundary shapes, so the guard is pinned against the
  // type here rather than left to drift until something starts consuming it.
  //
  // `hasUnexpectedKeys` in `src/contracts/validators/process-yaml.ts` is the
  // deeper gate the router actually runs; these assertions pin the published
  // guard surface agrees with it about what a legal command looks like.
  describe('process-yaml request shapes (FR-012, FR-020a, FR-055a)', () => {
    const exportCmd = (payload: unknown): unknown => ({
      type: Authoritative.CMD_EXPORT_PROCESS_YAML,
      correlationId: 'c-test',
      payload
    });

    it('accepts all three arms of the export union', () => {
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({ resourceKind: 'phase', resourceId: 'specify' })
        )
      ).toBe(true);
      for (const inclusion of ['references-only', 'include-referenced'] as const) {
        expect(
          Authoritative.isCmdExportProcessYaml(
            exportCmd({ resourceKind: 'pipeline', resourceId: 'default', inclusion })
          ),
          `pipeline export with inclusion '${inclusion}' must be accepted`
        ).toBe(true);
      }
      // Feature 086 (T005, T068) — three modes, because a Workflow's closure is
      // two levels deep. The middle one is what a Pipeline export has no use for.
      for (const inclusion of [
        'references-only',
        'include-pipelines',
        'include-closure'
      ] as const) {
        expect(
          Authoritative.isCmdExportProcessYaml(
            exportCmd({ resourceKind: 'workflow', resourceId: 'ship-it', inclusion })
          ),
          `workflow export with inclusion '${inclusion}' must be accepted`
        ).toBe(true);
      }
    });

    it('does not let the two kinds borrow each other’s inclusion vocabulary', () => {
      // The three arms exist so no illegal kind/mode pair is constructible. A
      // guard that checked `inclusion` against the UNION of both vocabularies
      // would accept both of these and the type would be a comment again.
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({
            resourceKind: 'pipeline',
            resourceId: 'default',
            inclusion: 'include-closure'
          })
        ),
        'a Pipeline has one level of dependency and no closure mode'
      ).toBe(false);
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({
            resourceKind: 'workflow',
            resourceId: 'ship-it',
            inclusion: 'include-referenced'
          })
        ),
        'a Workflow has two levels, so `include-referenced` names nothing'
      ).toBe(false);
    });

    it('rejects a Workflow export with a missing inclusion', () => {
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({ resourceKind: 'workflow', resourceId: 'ship-it' })
        ),
        'inclusion is required for a Workflow — it is the operator’s disclosure choice'
      ).toBe(false);
    });

    it('rejects a Phase export carrying an inclusion choice a Phase cannot have', () => {
      // The union exists precisely so this shape is unrepresentable. A guard
      // that merely ignored the extra field would let it cross the boundary.
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({
            resourceKind: 'phase',
            resourceId: 'specify',
            inclusion: 'include-referenced'
          })
        )
      ).toBe(false);
    });

    it('rejects a Pipeline export with a missing or unrecognized inclusion', () => {
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({ resourceKind: 'pipeline', resourceId: 'default' })
        ),
        'inclusion is required for a Pipeline — it is the operator’s disclosure choice'
      ).toBe(false);
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({ resourceKind: 'pipeline', resourceId: 'default', inclusion: 'all' })
        )
      ).toBe(false);
    });

    it('rejects an export naming a kind this format does not admit', () => {
      // 085 spelled this case `workflow`, which 086 makes legal. `queue` stands
      // in for the same thing: a kind outside the closed set the format admits.
      expect(
        Authoritative.isCmdExportProcessYaml(
          exportCmd({ resourceKind: 'queue', resourceId: 'default' })
        )
      ).toBe(false);
      expect(
        Authoritative.isCmdExportProcessYaml(exportCmd({ resourceId: 'specify' }))
      ).toBe(false);
    });

    it('accepts an empty preflight payload and rejects every field, including 084’s kind', () => {
      const preflight = (payload: unknown): unknown => ({
        type: Authoritative.CMD_PREFLIGHT_PROCESS_YAML,
        correlationId: 'c-test',
        payload
      });
      expect(Authoritative.isCmdPreflightProcessYaml(preflight({}))).toBe(true);
      // 084's payload. An operator must not have to classify a file before
      // opening it, so the kind is not the webview's to send any more.
      expect(
        Authoritative.isCmdPreflightProcessYaml(preflight({ resourceKind: 'phase' }))
      ).toBe(false);
      // A location must never be representable on this command in either
      // direction — the same invariant `process-yaml-no-paths.test.ts` covers.
      expect(
        Authoritative.isCmdPreflightProcessYaml(preflight({ path: '/tmp/x.pipeline.yaml' }))
      ).toBe(false);
      expect(Authoritative.isCmdPreflightProcessYaml(preflight(undefined))).toBe(false);
    });
  });

  // Feature 082 (US1, T019) — the catalog write commands are one contract shape.
  // The original drift this guard caught was a save forgetting its revision or its
  // mutation, which would have left the Builder and the Phase editor disagreeing
  // about what a revisioned complete-layer save is.
  //
  // Feature 099 (T496f, FR-042/FR-043) — `scope` left the envelope with the layer
  // tier: there is one catalog, so a save has nowhere to aim.
  //
  // Feature 100 (T514, FR-051) — and the layer save itself is gone. What replaces
  // it is six commands whose payload IS the lifecycle-service request, so the
  // property to guard inverted: a payload must **not** re-declare its own fields.
  // A second declaration of the same five fields would be a second place for the
  // wire and the service to drift silently, both sides being structural. `scope`
  // and `mutation` are checked as retired fields rather than required ones.
  it('every lifecycle command payload is the service request, re-declared nowhere', () => {
    // Declared together in the focused lifecycle module; the barrel re-exports
    // them so `sidebar-ipc.ts` remains the single import site for the wire
    // contract.
    const barrel = fs.readFileSync(path.join(REPO_ROOT, 'src/contracts/sidebar-ipc.ts'), 'utf8');
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/contracts/sidebar-ipc/catalog-lifecycle.ts'),
      'utf8'
    );
    const REQUESTS: Readonly<Record<string, string>> = {
      SaveDefinitionDraftCommand: 'SaveDraftRequest',
      PublishDefinitionCommand: 'PublishRequest',
      DeactivateDefinitionCommand: 'DeactivateRequest',
      RestoreDefinitionVersionCommand: 'RestoreRequest',
      DiscardDefinitionDraftCommand: 'DiscardDraftRequest',
      PublishPackageCommand: 'PackagePublishRequest'
    };

    for (const [command, request] of Object.entries(REQUESTS)) {
      expect(barrel, `sidebar-ipc.ts must re-export ${command}`).toMatch(
        new RegExp(`export type \\{[^}]*${command}[^}]*\\} from '\\./sidebar-ipc/catalog-lifecycle'`)
      );
      const declaration = source.match(
        new RegExp(`export interface ${command}[\\s\\S]*?\\n\\}`)
      )?.[0];
      expect(declaration, `${command} must declare a payload`).toBeDefined();
      // One line, naming the request. Anything else is a re-declaration.
      expect(declaration, `${command} payload must be ${request} itself`).toMatch(
        new RegExp(`readonly payload:\\s*${request};`)
      );
      for (const retired of ['scope', 'mutation', 'expectedRevision']) {
        expect(declaration, `${command} must not carry '${retired}'`).not.toMatch(
          new RegExp(`^\\s*(readonly\\s+)?${retired}\\s*[?:]`, 'm')
        );
      }
    }
  });

  it('host shim re-exports the identical lifecycle guards', () => {
    // Six commands, six guards, one guard table. A command added to the table
    // under a guard the shim does not re-export would let the host and the webview
    // disagree about whether a message is well-formed.
    const GUARDS = [
      ['CMD_SAVE_DEFINITION_DRAFT', 'isCmdSaveDefinitionDraft'],
      ['CMD_PUBLISH_DEFINITION', 'isCmdPublishDefinition'],
      ['CMD_DEACTIVATE_DEFINITION', 'isCmdDeactivateDefinition'],
      ['CMD_RESTORE_DEFINITION_VERSION', 'isCmdRestoreDefinitionVersion'],
      ['CMD_DISCARD_DEFINITION_DRAFT', 'isCmdDiscardDefinitionDraft'],
      ['CMD_PUBLISH_PACKAGE', 'isCmdPublishPackage']
    ] as const;

    for (const [command, guard] of GUARDS) {
      const authoritative = (Authoritative as unknown as Record<string, unknown>)[guard];
      expect(authoritative, `sidebar-ipc must export ${guard}`).toBeTypeOf('function');
      expect((HostShim as unknown as Record<string, unknown>)[guard]).toBe(authoritative);
      const type = (Authoritative as unknown as Record<string, string>)[command];
      expect(
        (Authoritative.COMMAND_GUARDS as unknown as Record<string, unknown>)[type]
      ).toBe(authoritative);
    }
  });

  it('SCHEMA_VERSION is a numeric integer constant', () => {
    expect(typeof Authoritative.SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(Authoritative.SCHEMA_VERSION)).toBe(true);
  });

  it('webview shim source re-exports the authoritative IPC module via a single export-* statement', () => {
    const shimPath = path.join(REPO_ROOT, 'webview-ui/src/lib/messages.ts');
    const text = fs.readFileSync(shimPath, 'utf8');

    // Strip line and block comments before matching.
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Must contain exactly one export-* targeting the authoritative module.
    // The `.js` extension is required by the webview's "type": "module"
    // declaration; bundler resolution maps it to the .ts source.
    const exportStarMatches = codeOnly.match(
      /export\s+\*\s+from\s+['"][^'"]*src\/contracts\/sidebar-ipc(?:\.js)?['"]/g
    ) ?? [];
    expect(
      exportStarMatches,
      'webview shim must contain exactly one export-* re-export of src/contracts/sidebar-ipc'
    ).toHaveLength(1);

    // No other top-level `export ...` statements that could shadow or
    // diverge from the canonical surface.
    const otherExports = codeOnly.match(/^\s*export\s+(?!\*\s+from\s)\S/gm) ?? [];
    expect(
      otherExports,
      'webview shim must not declare any local exports beyond the export-*'
    ).toEqual([]);
  });

  it('host shim source re-exports the authoritative IPC module via a single export-* statement', () => {
    const shimPath = path.join(REPO_ROOT, 'src/ui/sidebar/messages.ts');
    const text = fs.readFileSync(shimPath, 'utf8');
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const exportStarMatches = codeOnly.match(
      /export\s+\*\s+from\s+['"][^'"]*contracts\/sidebar-ipc(?:\.js)?['"]/g
    ) ?? [];
    expect(exportStarMatches).toHaveLength(1);
    const otherExports = codeOnly.match(/^\s*export\s+(?!\*\s+from\s)\S/gm) ?? [];
    expect(otherExports).toEqual([]);
  });
});
