// FR-R6-F15 T026 — the delivery plan: ordered prompt blocks, the route of each artifact, the
// session rule, the recorded representation and the check a dispatch passes.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ACP_PROTOCOL_VERSION, type NegotiatedCapabilities } from '../../../src/contracts/acp-runtime';
import type { ArtifactAccess, DeliveryPlan, DeliveryRepresentation } from '../../../src/contracts/phase-context/context-delivery';
import type { AcceptedRevision, HandoffManifest, ManifestSource } from '../../../src/contracts/phase-context/context-manifest';
import type { ArtifactRef } from '../../../src/contracts/phase-context/context-policy';
import { createAcceptanceService } from '../../../src/services/phase-context/acceptance';
import { checkDispatch, planDelivery, type DeliveryInput } from '../../../src/services/phase-context/delivery-plan';
import { buildManifest, type ManifestInput } from '../../../src/services/phase-context/manifest';
import { createMemoryHandoffStore } from '../../../src/services/phase-context/memory-store';
import { renderContext } from '../../../src/services/phase-context/renderer';
import { preparedOf } from '../../../src/services/phase-context/revision-edit';
import { artifactRef, digestOf, manifestInput, manifestSource, producer, profile, textOfBytes } from '../../fixtures/phase-context/builders';

const INSTRUCTIONS = 'Implement the plan. Keep the queue as it is.';
const TARGET_ATTEMPT = 'att-implement-1';
const KIB = 1024;

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A text artifact whose reference carries the real size and digest of its content. */
function textArtifact(artifactId: string, text: string): ArtifactRef {
  return artifactRef({ artifactId, digestHex: sha(text), byteSize: Buffer.byteLength(text, 'utf8'), kind: 'text' });
}

function capabilities(overrides: Partial<NegotiatedCapabilities> = {}): NegotiatedCapabilities {
  return { protocolVersion: ACP_PROTOCOL_VERSION, loadSession: true, image: false, audio: false, embeddedContext: true, authMethodCount: 0, ...overrides };
}

function access(overrides: Partial<ArtifactAccess> = {}): ArtifactAccess {
  return { embeddedText: null, linkUri: null, materializePermitted: false, materializedUri: null, ...overrides };
}

function linkOf(artifact: ArtifactRef): string {
  return `file:///artifacts/${artifact.artifactId}/${artifact.immutableVersion}`;
}

function manifestOf(sources: readonly ManifestSource[], overrides: Partial<ManifestInput> = {}, instructions = INSTRUCTIONS): HandoffManifest {
  return buildManifest(manifestInput(sources, { targetInstructionsDigest: sha(instructions), ...overrides }));
}

/** The revision the acceptance service stores for the manifest. */
function acceptedOf(manifest: HandoffManifest): AcceptedRevision {
  const result = createAcceptanceService(createMemoryHandoffStore()).accept(preparedOf(manifest));
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result.revision;
}

function inputOf(
  manifest: HandoffManifest,
  accesses: Readonly<Record<string, ArtifactAccess>> = {},
  overrides: Partial<DeliveryInput> = {}
): DeliveryInput {
  return {
    revision: acceptedOf(manifest),
    manifest,
    rendered: renderContext(manifest),
    targetInstructions: INSTRUCTIONS,
    targetAttemptId: TARGET_ATTEMPT,
    capabilities: capabilities(),
    profile: profile(),
    session: { kind: 'fresh' },
    accessOf: (artifact) => accesses[artifact.artifactId] ?? access(),
    ...overrides
  };
}

function planned(input: DeliveryInput): DeliveryPlan {
  const result = planDelivery(input);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result.plan;
}

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function routesOf(plan: DeliveryPlan): string[] {
  return plan.routes.map((route) => `${route.artifactId}:${route.route}`);
}

const NOTE = 'The retry count stays at three.';
const note = textArtifact('artifact-note', NOTE);
const diagram = artifactRef({ artifactId: 'artifact-diagram', kind: 'binary', byteSize: 4_096 });
const archive = artifactRef({ artifactId: 'artifact-archive', kind: 'binary', byteSize: 9_000 });

describe('planDelivery', () => {
  it('plans the instructions and the rendered context as two text blocks when there is no artifact', () => {
    const manifest = manifestOf([manifestSource()]);
    const input = inputOf(manifest);

    const plan = planned(input);

    expect(plan.blocks).toEqual([
      { type: 'text', text: INSTRUCTIONS },
      { type: 'text', text: renderContext(manifest).text }
    ]);
    expect(plan.routes).toEqual([]);
    expect(plan.awaitingCopy).toEqual([]);
    expect(plan.representation).toEqual({
      handoffId: manifest.handoffId,
      revision: 1,
      targetAttemptId: TARGET_ATTEMPT,
      contentDigest: input.revision.manifestDigest,
      rendererVersion: 1,
      renderedDigest: input.revision.renderedDigest,
      capabilities: capabilities(),
      profileId: 'profile-1',
      profileRevision: 1,
      session: 'fresh',
      routes: [],
      representationDigest: plan.representation.representationDigest
    });
    expect(plan.representation.representationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds one resource block per routed artifact, in manifest order', () => {
    const manifest = manifestOf([
      manifestSource('plan', { artifacts: [diagram, note] }),
      manifestSource('research', { artifacts: [archive] })
    ]);
    const plan = planned(
      inputOf(manifest, {
        'artifact-note': access({ embeddedText: NOTE }),
        'artifact-diagram': access({ linkUri: linkOf(diagram) }),
        'artifact-archive': access({ materializePermitted: true, materializedUri: 'file:///copies/artifact-archive' })
      })
    );

    expect(plan.blocks.slice(2)).toEqual([
      { type: 'resource-link', uri: linkOf(diagram), name: 'artifact-diagram' },
      { type: 'embedded-resource', uri: 'artifact:artifact-note@v1', text: NOTE, mimeType: 'text/plain' },
      { type: 'resource-link', uri: 'file:///copies/artifact-archive', name: 'artifact-archive' }
    ]);
    expect(plan.routes).toEqual([
      { artifactId: 'artifact-diagram', immutableVersion: 'v1', route: 'resource-link' },
      { artifactId: 'artifact-note', immutableVersion: 'v1', route: 'embedded' },
      { artifactId: 'artifact-archive', immutableVersion: 'v1', route: 'materialized-copy' }
    ]);
    expect(plan.representation.routes).toEqual(plan.routes);
    expect(plan.awaitingCopy).toEqual([]);
  });

  it.each([
    ['embedded before a link and a copy', note, access({ embeddedText: NOTE, linkUri: linkOf(note), materializePermitted: true }), capabilities(), 'embedded'],
    ['a link when embedded context was not negotiated', note, access({ embeddedText: NOTE, linkUri: linkOf(note) }), capabilities({ embeddedContext: false }), 'resource-link'],
    ['a link when no content is supplied', note, access({ linkUri: linkOf(note), materializePermitted: true }), capabilities(), 'resource-link'],
    ['a link for a binary artifact', diagram, access({ embeddedText: 'text', linkUri: linkOf(diagram) }), capabilities(), 'resource-link'],
    ['a copy when there is no link', diagram, access({ materializePermitted: true, materializedUri: 'file:///copies/d' }), capabilities(), 'materialized-copy'],
    ['a copy for content that was not negotiated', note, access({ embeddedText: NOTE, materializePermitted: true, materializedUri: 'file:///copies/n' }), capabilities({ embeddedContext: false }), 'materialized-copy']
  ])('routes %s', (_label, artifact, answer, negotiated, route) => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [artifact] })]);

    const plan = planned(inputOf(manifest, { [artifact.artifactId]: answer }, { capabilities: negotiated }));

    expect(routesOf(plan)).toEqual([`${artifact.artifactId}:${route}`]);
  });

  it('embeds a text artifact of exactly 8 KiB and links a larger one', () => {
    const atLimit = textOfBytes(8 * KIB);
    const over = textOfBytes(8 * KIB + 1, 'b');
    const first = textArtifact('artifact-at-limit', atLimit);
    const second = textArtifact('artifact-over', over);
    const manifest = manifestOf([manifestSource('plan', { artifacts: [first, second] })]);

    const plan = planned(
      inputOf(manifest, {
        'artifact-at-limit': access({ embeddedText: atLimit, linkUri: linkOf(first) }),
        'artifact-over': access({ embeddedText: over, linkUri: linkOf(second) })
      })
    );

    expect(routesOf(plan)).toEqual(['artifact-at-limit:embedded', 'artifact-over:resource-link']);
  });

  it('counts the rendered context and every embedded artifact against the qualified bound', () => {
    const firstText = textOfBytes(1_000);
    const secondText = textOfBytes(1_000, 'b');
    const first = textArtifact('artifact-first', firstText);
    const second = textArtifact('artifact-second', secondText);
    const manifest = manifestOf([manifestSource('plan', { artifacts: [first, second] })]);
    const renderedBytes = renderContext(manifest).bytes;
    const accesses = {
      'artifact-first': access({ embeddedText: firstText, linkUri: linkOf(first) }),
      'artifact-second': access({ embeddedText: secondText, linkUri: linkOf(second) })
    };

    const both = planned(inputOf(manifest, accesses, { profile: profile({ qualifiedContextBytes: renderedBytes + 2_000 }) }));
    const one = planned(inputOf(manifest, accesses, { profile: profile({ qualifiedContextBytes: renderedBytes + 1_999 }) }));
    const none = planned(inputOf(manifest, accesses, { profile: profile({ qualifiedContextBytes: renderedBytes }) }));

    expect(routesOf(both)).toEqual(['artifact-first:embedded', 'artifact-second:embedded']);
    expect(routesOf(one)).toEqual(['artifact-first:embedded', 'artifact-second:resource-link']);
    expect(routesOf(none)).toEqual(['artifact-first:resource-link', 'artifact-second:resource-link']);
  });

  it('refuses a required artifact that fits no route and no bound', () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [note] })]);
    const bound = renderContext(manifest).bytes;

    const result = planDelivery(inputOf(manifest, { 'artifact-note': access({ embeddedText: NOTE }) }, { profile: profile({ qualifiedContextBytes: bound }) }));

    expect(result).toEqual(refusal('required-context-unavailable', 'artifact-unroutable'));
  });

  it('omits an optional artifact with no route and writes no block for it', () => {
    const manifest = manifestOf([manifestSource('plan'), manifestSource('research', { required: false, artifacts: [diagram] })]);

    const plan = planned(inputOf(manifest));

    expect(plan.routes).toEqual([{ artifactId: 'artifact-diagram', immutableVersion: 'v1', route: 'omitted' }]);
    expect(plan.blocks).toHaveLength(2);
  });

  it('routes an artifact two sources carry once, as required when either source is required', () => {
    const manifest = manifestOf([
      manifestSource('research', { required: false, artifacts: [diagram] }),
      manifestSource('plan', { artifacts: [diagram] })
    ]);
    const seen: string[] = [];
    const answered: DeliveryInput['accessOf'] = (artifact) => {
      seen.push(artifact.artifactId);
      return access({ linkUri: linkOf(artifact) });
    };

    const plan = planned(inputOf(manifest, {}, { accessOf: answered }));

    expect(routesOf(plan)).toEqual(['artifact-diagram:resource-link']);
    expect(plan.blocks).toHaveLength(3);
    expect(seen).toEqual(['artifact-diagram']);
    expect(planDelivery(inputOf(manifest))).toEqual(refusal('required-context-unavailable', 'artifact-unroutable'));
  });

  it('asks for the access of each artifact with its whole reference', () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [note, diagram] })]);
    const asked: ArtifactRef[] = [];

    planned(
      inputOf(manifest, {}, {
        accessOf: (artifact) => {
          asked.push(artifact);
          return access({ linkUri: linkOf(artifact) });
        }
      })
    );

    expect(asked).toEqual([note, diagram]);
  });

  it('waits for a permitted copy: the artifact is listed and no block is written', () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [diagram, archive] })]);
    const waiting = planned(
      inputOf(manifest, {
        'artifact-diagram': access({ linkUri: linkOf(diagram) }),
        'artifact-archive': access({ materializePermitted: true })
      })
    );
    const copied = planned(
      inputOf(manifest, {
        'artifact-diagram': access({ linkUri: linkOf(diagram) }),
        'artifact-archive': access({ materializePermitted: true, materializedUri: 'file:///copies/artifact-archive' })
      })
    );

    expect(waiting.awaitingCopy).toEqual(['artifact-archive']);
    expect(waiting.blocks).toEqual([]);
    expect(routesOf(waiting)).toEqual(['artifact-diagram:resource-link', 'artifact-archive:materialized-copy']);
    expect(copied.awaitingCopy).toEqual([]);
    expect(copied.blocks).toHaveLength(4);
    expect(copied.representation).toEqual(waiting.representation);
  });

  it.each([
    ['a revision that waits for approval', 'waiting-approval' as const],
    ['a superseded revision', 'superseded' as const]
  ])('refuses %s', (_label, state) => {
    const base = inputOf(manifestOf([manifestSource()]));

    expect(planDelivery({ ...base, revision: { ...base.revision, state } })).toEqual(refusal('stale-revision', 'revision-not-ready'));
  });

  it('refuses a revision rendered by a renderer this host does not have', () => {
    const base = inputOf(manifestOf([manifestSource()]));

    expect(planDelivery({ ...base, revision: { ...base.revision, rendererVersion: 2 } })).toEqual(refusal('unsupported-version', 'renderer-version'));
  });

  it('refuses a manifest that is not the one the revision records', () => {
    const base = inputOf(manifestOf([manifestSource()]));
    const other = manifestOf([manifestSource('plan', { outcomes: ['The plan lists five steps.'] })]);

    expect(planDelivery({ ...base, manifest: other })).toEqual(refusal('stale-revision', 'manifest-mismatch'));
    expect(planDelivery({ ...base, revision: { ...base.revision, manifestDigest: digestOf('e') } })).toEqual(refusal('stale-revision', 'manifest-mismatch'));
  });

  it.each([
    ['another text', (rendered: DeliveryInput['rendered']) => ({ ...rendered, text: `${rendered.text}> more\n` })],
    ['another digest', (rendered: DeliveryInput['rendered']) => ({ ...rendered, digestHex: digestOf('e') })],
    ['another size', (rendered: DeliveryInput['rendered']) => ({ ...rendered, bytes: rendered.bytes + 1 })]
  ])('refuses a rendered context with %s than the revision records', (_label, change) => {
    const base = inputOf(manifestOf([manifestSource()]));

    expect(planDelivery({ ...base, rendered: change(base.rendered) })).toEqual(refusal('stale-revision', 'rendered-mismatch'));
  });

  it('refuses a revision whose recorded rendering is not the rendering of its manifest', () => {
    const base = inputOf(manifestOf([manifestSource()]));

    expect(planDelivery({ ...base, revision: { ...base.revision, renderedDigest: digestOf('e') } })).toEqual(refusal('stale-revision', 'rendered-mismatch'));
    expect(planDelivery({ ...base, revision: { ...base.revision, renderedBytes: base.revision.renderedBytes + 1 } })).toEqual(
      refusal('stale-revision', 'rendered-mismatch')
    );
  });

  it('refuses instructions that are not the ones the manifest was prepared for', () => {
    const base = inputOf(manifestOf([manifestSource()]));

    expect(planDelivery({ ...base, targetInstructions: `${INSTRUCTIONS} ` })).toEqual(refusal('stale-revision', 'instructions-mismatch'));
    expect(planDelivery({ ...base, targetInstructions: 7 as unknown as string })).toEqual(refusal('invalid-source', 'target-instructions'));
  });

  it('refuses a profile with no qualified bound, and a rendered context over the bound', () => {
    const manifest = manifestOf([manifestSource()]);
    const bytes = renderContext(manifest).bytes;

    expect(planDelivery(inputOf(manifest, {}, { profile: profile({ qualifiedContextBytes: null }) }))).toEqual(refusal('capacity-exceeded', 'profile-unqualified'));
    expect(planDelivery(inputOf(manifest, {}, { profile: profile({ qualifiedContextBytes: bytes - 1 }) }))).toEqual(refusal('capacity-exceeded', 'qualified-bound'));
    expect(planDelivery(inputOf(manifest, {}, { profile: profile({ qualifiedContextBytes: bytes }) })).ok).toBe(true);
  });

  it.each([
    ['a target attempt that is not an identifier', { targetAttemptId: 'att 1' }, 'target-attempt'],
    ['capabilities with a flag that is not a boolean', { capabilities: { ...capabilities(), embeddedContext: 'yes' } as unknown as NegotiatedCapabilities }, 'capabilities'],
    ['capabilities of another protocol version', { capabilities: { ...capabilities(), protocolVersion: 2 } as unknown as NegotiatedCapabilities }, 'capabilities'],
    ['capabilities with a key the contract does not name', { capabilities: { ...capabilities(), terminal: true } as unknown as NegotiatedCapabilities }, 'capabilities'],
    ['a profile with no identifier', { profile: profile({ profileId: '' }) }, 'profile'],
    ['a profile revision that is not a whole number', { profile: profile({ profileRevision: 1.5 }) }, 'profile'],
    ['a qualified bound of zero', { profile: profile({ qualifiedContextBytes: 0 }) }, 'profile'],
    ['a session of an unknown kind', { session: { kind: 'resume' } as unknown as DeliveryInput['session'] }, 'session-shape']
  ])('refuses %s', (_label, overrides, detail) => {
    expect(planDelivery(inputOf(manifestOf([manifestSource()]), {}, overrides))).toEqual(refusal('invalid-source', detail));
  });

  describe('the session rule', () => {
    const target = producer('implement', 'occ-1', TARGET_ATTEMPT);
    const earlier = producer('implement', 'occ-1', 'att-implement-0');
    const reusable = manifestOf([manifestSource()], { session: 'reuse-when-qualified' });

    it('lets a fresh session through under either policy', () => {
      expect(planned(inputOf(reusable)).representation.session).toBe('fresh');
      expect(planned(inputOf(manifestOf([manifestSource()]))).representation.session).toBe('fresh');
    });

    it('lets the target reuse a session of its own lineage', () => {
      const plan = planned(inputOf(reusable, {}, { session: { kind: 'reuse', sessionLineage: earlier, targetLineage: target } }));

      expect(plan.representation.session).toBe('reuse');
    });

    it('refuses reuse under a fresh policy', () => {
      const result = planDelivery(inputOf(manifestOf([manifestSource()]), {}, { session: { kind: 'reuse', sessionLineage: earlier, targetLineage: target } }));

      expect(result).toEqual(refusal('invalid-policy', 'session-reuse-not-permitted'));
    });

    it.each([
      ['another node', producer('plan', 'occ-1', 'att-plan')],
      ['another occurrence of the target node', producer('implement', 'occ-2', 'att-implement-0')]
    ])('refuses a session that belongs to %s', (_label, sessionLineage) => {
      const result = planDelivery(inputOf(reusable, {}, { session: { kind: 'reuse', sessionLineage, targetLineage: target } }));

      expect(result).toEqual(refusal('invalid-source', 'session-lineage'));
    });

    it.each([
      ['another node', producer('review', 'occ-1', TARGET_ATTEMPT)],
      ['another occurrence', producer('implement', 'occ-2', TARGET_ATTEMPT)],
      ['another attempt than the one being dispatched', producer('implement', 'occ-1', 'att-implement-9')]
    ])('refuses a target lineage that names %s', (_label, targetLineage) => {
      const result = planDelivery(inputOf(reusable, {}, { session: { kind: 'reuse', sessionLineage: targetLineage, targetLineage } }));

      expect(result).toEqual(refusal('invalid-source', 'session-target'));
    });

    it('refuses a lineage that is not a producer reference', () => {
      const broken = { kind: 'reuse', sessionLineage: { nodePath: 'implement' }, targetLineage: target } as unknown as DeliveryInput['session'];

      expect(planDelivery(inputOf(reusable, {}, { session: broken }))).toEqual(refusal('invalid-source', 'session-shape'));
    });
  });

  describe('embedded content', () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [note] })]);

    it.each([
      ['shorter than its reference says', NOTE.slice(1), 'embedded-size'],
      ['longer than its reference says', `${NOTE}.`, 'embedded-size'],
      ['of the same size and another digest', `${NOTE.slice(0, -1)}!`, 'embedded-digest']
    ])('refuses content %s', (_label, embeddedText, detail) => {
      const result = planDelivery(inputOf(manifest, { 'artifact-note': access({ embeddedText, linkUri: linkOf(note) }) }));

      expect(result).toEqual(refusal('invalid-source', detail));
    });

    it('does not read content it would not embed', () => {
      const plan = planned(inputOf(manifest, { 'artifact-note': access({ embeddedText: 'other', linkUri: linkOf(note) }) }, { capabilities: capabilities({ embeddedContext: false }) }));

      expect(routesOf(plan)).toEqual(['artifact-note:resource-link']);
    });

    it('keeps no refused content in the refusal', () => {
      const seeded = textOfBytes(64, 'z');

      expect(JSON.stringify(planDelivery(inputOf(manifest, { 'artifact-note': access({ embeddedText: seeded }) })))).not.toContain('zzzz');
    });
  });

  describe("the host's answer about an artifact", () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [diagram] })]);

    it.each([
      ['not a record', 'file:///artifacts/d'],
      ['with a key the contract does not name', { ...access(), note: 'x' }],
      ['with content that is not text', access({ embeddedText: 7 as unknown as string })],
      ['with a link that is not text', access({ linkUri: 7 as unknown as string })],
      ['with an empty link', access({ linkUri: '' })],
      ['with a link over 2 KiB', access({ linkUri: `file:///${textOfBytes(2 * KIB)}` })],
      ['with a control character in a link', access({ linkUri: `file:///a${String.fromCharCode(10)}b` })],
      ['with a permission that is not a boolean', access({ materializePermitted: 1 as unknown as boolean })],
      ['with an empty copy location', access({ materializePermitted: true, materializedUri: '' })]
    ])('is refused when it is %s', (_label, answer) => {
      const result = planDelivery(inputOf(manifest, {}, { accessOf: () => answer as ArtifactAccess }));

      expect(result).toEqual(refusal('invalid-source', 'artifact-access'));
    });

    it('is refused by a fixed code when the host throws, with no text of the error', () => {
      const result = planDelivery(
        inputOf(manifest, {}, {
          accessOf: () => {
            throw new Error('disk path /private/secret is gone');
          }
        })
      );

      expect(result).toEqual(refusal('invalid-source', 'artifact-access'));
    });

    it('is not used for a copy that was not permitted', () => {
      const plan = planned(
        inputOf(manifestOf([manifestSource('plan'), manifestSource('research', { required: false, artifacts: [diagram] })]), {
          'artifact-diagram': access({ materializePermitted: false, materializedUri: 'file:///copies/d' })
        })
      );

      expect(routesOf(plan)).toEqual(['artifact-diagram:omitted']);
    });
  });

  it('refuses two references that name one artifact version with different content', () => {
    const manifest = manifestOf([
      manifestSource('plan', { artifacts: [diagram] }),
      manifestSource('research', { artifacts: [{ ...diagram, byteSize: diagram.byteSize + 1 }] })
    ]);

    expect(planDelivery(inputOf(manifest))).toEqual(refusal('invalid-source', 'artifact-conflict'));
  });

  it('refuses blocks over the prompt size limit', () => {
    const instructions = textOfBytes(2 * KIB * KIB + 1);
    const manifest = manifestOf([manifestSource()], {}, instructions);

    expect(planDelivery(inputOf(manifest, {}, { targetInstructions: instructions }))).toEqual(refusal('capacity-exceeded', 'prompt-bytes'));
  });

  it('gives equal plans for equal input', () => {
    const manifest = manifestOf([manifestSource('plan', { artifacts: [note, diagram] })]);
    const accesses = { 'artifact-note': access({ embeddedText: NOTE }), 'artifact-diagram': access({ linkUri: linkOf(diagram) }) };

    expect(planDelivery(inputOf(manifest, accesses))).toEqual(planDelivery(inputOf(manifest, accesses)));
  });

  it('gives another representation digest when what a dispatch must match changes', () => {
    const manifest = manifestOf([manifestSource('plan'), manifestSource('research', { required: false, artifacts: [diagram] })]);
    const digestOfPlan = (overrides: Partial<DeliveryInput>, accesses: Readonly<Record<string, ArtifactAccess>> = {}): string =>
      planned(inputOf(manifest, accesses, overrides)).representation.representationDigest;
    const base = digestOfPlan({});

    expect(digestOfPlan({})).toBe(base);
    expect(digestOfPlan({ targetAttemptId: 'att-implement-2' })).not.toBe(base);
    expect(digestOfPlan({ capabilities: capabilities({ image: true }) })).not.toBe(base);
    expect(digestOfPlan({ profile: profile({ profileRevision: 2 }) })).not.toBe(base);
    expect(digestOfPlan({ profile: profile({ profileId: 'profile-2' }) })).not.toBe(base);
    expect(digestOfPlan({}, { 'artifact-diagram': access({ linkUri: linkOf(diagram) }) })).not.toBe(base);
    // The qualified bound is not part of the record: only the profile revision is.
    expect(digestOfPlan({ profile: profile({ qualifiedContextBytes: 32 * KIB }) })).toBe(base);
  });
});

describe('checkDispatch', () => {
  const manifest = manifestOf([manifestSource()]);
  const base = inputOf(manifest);
  const representation: DeliveryRepresentation = planned(base).representation;
  const current = { capabilities: capabilities(), profile: profile(), contentDigest: base.revision.manifestDigest };

  it('accepts a dispatch whose capabilities, profile and content are the recorded ones', () => {
    expect(checkDispatch(representation, current)).toEqual({ ok: true });
    expect(checkDispatch(representation, { ...current, profile: profile({ qualifiedContextBytes: 32 * KIB }) })).toEqual({ ok: true });
  });

  it.each([
    ['load session', { loadSession: false }],
    ['image', { image: true }],
    ['audio', { audio: true }],
    ['embedded context', { embeddedContext: false }],
    ['the count of authentication methods', { authMethodCount: 1 }]
  ])('refuses a dispatch after %s changed', (_label, overrides) => {
    expect(checkDispatch(representation, { ...current, capabilities: capabilities(overrides) })).toEqual(refusal('stale-revision', 'capabilities-changed'));
  });

  it('refuses a dispatch under another profile or another revision of it', () => {
    expect(checkDispatch(representation, { ...current, profile: profile({ profileId: 'profile-2' }) })).toEqual(refusal('stale-revision', 'profile-changed'));
    expect(checkDispatch(representation, { ...current, profile: profile({ profileRevision: 2 }) })).toEqual(refusal('stale-revision', 'profile-changed'));
  });

  it('refuses a dispatch of other content', () => {
    expect(checkDispatch(representation, { ...current, contentDigest: digestOf('e') })).toEqual(refusal('stale-revision', 'content-changed'));
  });

  it.each([
    ['another attempt', { targetAttemptId: 'att-implement-2' }],
    ['another session', { session: 'reuse' as const }],
    ['another route', { routes: [{ artifactId: 'artifact-1', immutableVersion: 'v1', route: 'embedded' as const }] }],
    ['another rendered digest', { renderedDigest: digestOf('e') }]
  ])('refuses a record that was changed after it was written: %s', (_label, overrides) => {
    expect(checkDispatch({ ...representation, ...overrides }, current)).toEqual(refusal('stale-revision', 'representation-digest'));
  });
});
