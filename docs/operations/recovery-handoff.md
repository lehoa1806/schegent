# Recovery Handoff (`FR-R6-F08`)

**Declared**: 2026-11-10 (`specs/307-durable-handoff-resume/spec.md`)

This guide is for an integrator who composes the recovery handoff service into an execution
path, and for an operator who has to read a handoff's state after a restart: what it protects,
why it refuses a delivery, and what can be done next.

A recovery handoff is the durable record that lets an interrupted attempt continue in a new
attempt. It names the artifacts the next attempt needs, pins them so retention cannot collect
them, records every delivery intent and every operator decision, and survives a host restart at
every step. It carries identities, digests, counts and a bounded metadata manifest; it holds no
content.

Implemented in:
- [`src/contracts/recovery-handoff/handoff-types.ts`](../../src/contracts/recovery-handoff/handoff-types.ts)
- [`src/contracts/recovery-handoff/handoff-manifest.ts`](../../src/contracts/recovery-handoff/handoff-manifest.ts)
- [`src/services/recovery-handoff/recovery-handoff-service.ts`](../../src/services/recovery-handoff/recovery-handoff-service.ts), the single entry point
- [`src/services/recovery-handoff/handoff-schema.ts`](../../src/services/recovery-handoff/handoff-schema.ts), SQLite migration 5 (`005_f08_recovery_handoff`)
- [`src/services/recovery-handoff/handoff-pins.ts`](../../src/services/recovery-handoff/handoff-pins.ts)
- [`src/services/recovery-handoff/handoff-envelope-protection.ts`](../../src/services/recovery-handoff/handoff-envelope-protection.ts), restart-durable SQLite envelope protection assessment (`16-11`)
- [`src/services/recovery-handoff/handoff-resolver.ts`](../../src/services/recovery-handoff/handoff-resolver.ts)
- [`src/services/recovery-handoff/delivery-policy.ts`](../../src/services/recovery-handoff/delivery-policy.ts)
- [`src/services/recovery-handoff/session-plan.ts`](../../src/services/recovery-handoff/session-plan.ts)
- [`src/services/recovery-handoff/handoff-explanation.ts`](../../src/services/recovery-handoff/handoff-explanation.ts)
- [`src/services/recovery-handoff/legacy-handoff-mapping.ts`](../../src/services/recovery-handoff/legacy-handoff-mapping.ts)
- [`src/services/run-checkpoint-service.ts`](../../src/services/run-checkpoint-service.ts), checkpoint retention and envelope prune fail-safe
- [`src/activation/sqlite-cutover-wiring.ts`](../../src/activation/sqlite-cutover-wiring.ts), [`src/activation/sqlite-cutover-helpers.ts`](../../src/activation/sqlite-cutover-helpers.ts), and [`src/activation/run-safety-wiring.ts`](../../src/activation/run-safety-wiring.ts), production cutover composition

## Production status

What ships and runs in production cutover:

- **The handoff service and its five tables.** `createSqliteCutoverCoordinator` in
  `src/activation/sqlite-cutover-wiring.ts` constructs `RecoveryHandoffService` (wired with
  `ArtifactLifecycleService`, the contained byte probe, `RunCheckpointService`, and
  `acpRuntimeStore.sessionBindings`), calls `reopen()` on primary activation and restore reload,
  and delegates F05 `'handoff'` owner resolution through `handoffOwnerResolution`.
- **Authoritative checkpoint envelope protection (`16-11`).** `src/activation/run-safety-wiring.ts`
  wires `RunCheckpointService` to `SqliteCutoverCoordinator.isRecoveryEnvelopeProtected(runSegment, handoverSegment)`
  backed by `assessRecoveryEnvelopeProtection` over SQLite (see [Prune fail-safe](#prune-fail-safe)).

What remains outside this module's direct UI scope:

- **Delivery port callers.** ACP delivery orchestration consumes `RecoveryHandoffService` via the
  host cutover seam (`DurableArtifactHandoverSeam` verifies registered availability, accepted store
  kind, and durable locator presence).
- **Explanation UI / export surfaces.** `explain(handoffId)` is a host-side bounded product.

## States

| State | Meaning | Next actions |
|---|---|---|
| `preparing` | Created by `prepare`; no revision issued yet. | `none` |
| `ready` | A revision is issued and its required references are pinned. | `deliver` |
| `delivering` | An intent is recorded and not yet settled. | `await-acknowledgement` |
| `acknowledged` | The target attempt acknowledged the delivery. | `none` (the caller consumes it) |
| `uncertain` | A delivery was pending when the host restarted; whether it arrived is unknown. | `decide`, `inspect-evidence` |
| `consumed` | Closed: delivered (`closed_reason` `delivered`) or abandoned (`abandoned`). | `none` |
| `superseded` | Closed by `supersede` (`closed_reason` `superseded`). | `none` |
| `unsupported` | Written by a newer build, or imported from a legacy record of an unknown version. | `inspect-evidence` |

`consumed` and `superseded` are closed: no operation changes a closed handoff. A blocked
required reference or an unreadable manifest replaces `deliver` with `inspect-evidence`.

A failed delivery (`reportNotSent`) returns the handoff to `ready`, or to `uncertain` while an
earlier delivery is still uncertain, and releases nothing. `consume` repeats as `ok` only for a
handoff it delivered; on an abandoned handoff it refuses with `conflict`. Only
`consume`, an accepted `abandon` decision and `supersede` release pins, and `reopen` finishes a
release that a restart interrupted.

Revisions move `draft` to `issued` to `superseded` and never back. An issued or superseded
revision is immutable: database triggers refuse any change to its manifest, its issue time or a
deletion of the row. Issuing a new revision supersedes the previous one and keeps its manifest.

## Pins

Each artifact a handoff names is pinned through the F05 artifact lifecycle as a protective
reference owned by `('handoff', handoffId)`. Pins are per handoff, not per revision.

| Purpose | Held while |
|---|---|
| `pending-handoff` | The handoff is open, not paused and not `uncertain`. |
| `uncertain-recovery` | The handoff is `uncertain`. |
| `paused-recovery` | The handoff is paused (`setHandoffPaused(true)`), in any open state. |

- **A purpose switch never leaves a gap.** The new purpose is added before the old one is
  released. The target purpose is stored on the handoff row while a switch is in flight, so
  `reopen` finishes an interrupted switch.
- **One F05 slot stays in reserve.** A handoff pins at most `ARTIFACT_PINS_PER_OWNER_MAX - 1`
  distinct artifacts, so each step of a switch fits under the F05 quota.
- **Only the handoff's own pins are released.** Another owner's reference to the same artifact
  is never touched.
- **A required reference must pin.** If it cannot, `prepare` and `issue` refuse with
  `required-pin-refused`. An optional reference that cannot pin is reported in `pinRefusals`.
- **Owner resolution.** For the F05 resolver, `handoffOwnerResolution` reports `live` for every
  open state, including `unsupported` and paused handoffs, so nothing they name is collected. It
  reports `settled` for `consumed` and `superseded`, and `unresolved` for an unknown id or a
  store a newer build wrote. F05 keeps the artifact of an unresolved owner.

## Resolution reasons

`resolve(handoffId, revisionNo?)` and `verifyForUse(handoffId, options?)` freshly verify each
reference of a revision against F05 metadata **and** on-disk bytes/digests at use (`16-12`), never
trusting cached `last_resolution = 'available'` or stale F05 `availability = 'present'` metadata:

- Digested `present` references are always existence-checked (when `probe.observe` is provided)
  and hashed via `probe.digestSha256` against `expectedDigest` (or the F05 record digest).
- No-digest `present` references (for example growing artifacts) are existence-checked via
  `probe.observe` when provided so deleted bytes resolve `missing` instead of `available`.
- When `manifest.envelope` is non-null, its bytes/digest are verified at use when registered in
  F05, present under the checkpoint envelope port at `(rootExecutionId, envelope.artifactId)`, or
  addressed via `verifyForUse(..., { envelopeLocation })`; any non-`available` `envelopeResolution`
  blocks the revision.
- `recordIntent` verifies `input.envelopeDigest` equals `manifest.envelope.digest` whenever the
  revision manifest names an envelope (refusing mismatches with `conflict`).

Each reference result is written to `last_resolution`, so `explain` reports the latest verified
state without probing again. The artifact locator never leaves the host.

| Resolution | Meaning |
|---|---|
| `available` | Present, of an accepted store kind, and its bytes match any expected digest. |
| `missing` | No F05 record exists, or the record reports its bytes missing. |
| `expired` | Retention expired the artifact. |
| `deleted` | The artifact was deleted. |
| `unreadable` | The record is corrupt, unverified or still pending, or the bytes could not be read. |
| `changed` | The bytes no longer match the expected digest. |
| `unsupported` | The record's store kind is not one a handoff may name, or a newer build wrote the record. |

Accepted store kinds: `checkpoint`, `handoff-context`, `report`, `review-report`, `diagnostic`,
`live-log-segment`.

`resolve` refuses with `unsupported-version` when the handoff is `unsupported`, when the store
was written by a newer build, or when the revision's `manifest_version` is above 1.

## Redelivery rules

`recordIntent` records at most one intent per target attempt. A repeat with the same fields
returns the stored intent as a duplicate, and a repeat that differs is `conflict`. Refusals are
checked in this order, and the first that applies is returned:

1. `handoff-closed`
2. `unsupported-version`, including a revision with `manifest_version` above 1
3. `stale-revision`: the request names a revision that is not the current one
4. `delivery-in-flight`: an earlier intent is still pending
5. `attempt-reused`: the target attempt already received an intent
6. `direct-backend-refused`
7. `new-connection-refused`
8. `profile-changed-refused`
9. `decision-required`

Rules 6 to 9 apply only once an earlier intent exists. A new attempt is automatic only when
every earlier intent was refused before it was sent and the effect certainty is `safe`.
Otherwise a direct backend is always refused, and anything else needs an accepted, unused
`continue-new-attempt` decision on the current revision. Without one, the refusal names what
changed: the connection, then the profile, else `decision-required`.

A decision forces a fresh session. It lapses at the next intent recorded, whether or not the
guard needed it, or at the next outcome recorded for any intent (acknowledged, not sent, or
uncertain at restart), whichever comes first. So a decision never authorizes an attempt after an
outcome recorded after it. Without a decision, the session plan loads the prior session only
when all of these hold:

- the prior id is an ACP session id, never a legacy provider id;
- the owner, profile, backend and capability set are unchanged;
- the backend declares session loading;
- no uncertain earlier delivery forces a fresh session.

Loading a session never settles effect certainty.

### Delivery outcomes

| Outcome | Reason | Written by |
|---|---|---|
| `pending` | | `recordIntent` |
| `acknowledged` | | `acknowledge` |
| `refused` | `not-sent` | `reportNotSent` |
| `uncertain` | `restart-before-ack` | `reopen`, for every intent still pending at restart |

The schema also allows the reason `connection-lost`. No operation in this release writes it.

### Decisions

`decide(handoffId, revisionNo, decision, requestId)` records `continue-new-attempt` or
`abandon`. The decision id derives from the handoff and the request id, so a retried request
returns the stored outcome, and a retry that changes the decision or revision is `conflict`. A
decision on a revision that is no longer current is stored `refused-stale`, and one on a closed
handoff `refused-closed`: these are durable facts that permit no attempt, not errors. An
accepted `abandon` consumes the handoff with `closed_reason` `abandoned` and releases every pin.

## Explanation bounds

`explain(handoffId)` reads rows and writes none. It reports the handoff's state, what the
current revision carries and left out (and why), its deliveries and decisions, and its next
actions.

- **Size.** The serialized explanation is at most 65,536 bytes. Above that the lists are
  trimmed from their ends, the heaviest list first, and `truncatedCounts` records how many items
  each list lost. Trimming is never an error.
- **Bounded decision read work (`16-13`).** `explain` does not load arbitrarily many historical
  decision/refusal rows into memory. `SqliteHandoffStore.listRecentDecisions` runs a SQL
  `COUNT(*)` plus `ORDER BY recorded_at_ms DESC, decision_id DESC LIMIT 900`
  (`EXPLANATION_DECISION_PAGE_LIMIT = 900`, strictly above the ~869 minimum-size decisions that can
  fit in 65,536 bytes) and seeds the pre-omitted count into `truncatedCounts.decisions` so
  `explanation.decisions.length + explanation.truncatedCounts.decisions === totalDecisions` holds
  exactly while bounding SQLite reads and JS memory to `O(1)` regardless of refusal history.
  Likewise, `recordIntent` performs a bounded `O(1)` `LIMIT 1` lookup for the newest matching
  unconsumed accepted decision (`SqliteHandoffStore.findUnconsumedAcceptedDecision` in
  `src/services/recovery-handoff/handoff-store.ts`) and settlement lapses outstanding decisions via
  a single SQL `UPDATE` (`lapseOutstandingDecisions`).
- **Order.** Deliveries and decisions are listed newest first (tie-broken by descending id,
  matching SQLite), so trimming drops the oldest.
- **No paths.** Workspace attribution is reported as counts by category, never as paths. A
  string that still looks like an absolute path throws `HandoffExplanationContentError`, which
  names the field and never the value.
- **Manifest limits.** A manifest is at most 16,384 bytes, with at most 32 references per role,
  100 workspace entries and 32 excluded items. Legacy provenance is at most 2,048 bytes.
- **Exclusion reasons.** `policy-denied`, `raw-transcript`, `vendor-session-store`, `over-limit`,
  `late-fact`, `sensitivity`.

## Future versions

A revision whose `manifest_version` is above 1 was written by a newer build. It is kept exactly
as stored and never rewritten or deleted. `resolve`, `recordIntent`, `decide` and `supersede`
refuse it with `unsupported-version`, and the explanation reports state `unsupported`. The same
`decide` and `supersede` refusal applies to an `unsupported` handoff imported from a legacy
record, so neither is ever closed and their pins are never released. A store whose migration
level is above this build's refuses every operation with `unsupported-version`, and its handoff
owners resolve `unresolved`, so F05 keeps what they name.

## Legacy records

`importLegacy(record)` maps a record captured before the cutover safely and retryably (`16-12`):

- **Retry-safe initial pause.** Initial `paused = 1` for a `paused` legacy record is committed
  atomically on initial `INSERT` ONLY (`ON CONFLICT DO NOTHING`). Retrying the legacy drain for
  the same record preserves any intervening operator resume (`setHandoffPaused(handoffId, false)`)
  and never re-pauses or re-switches pins back to `paused-recovery`.
- **Ids, outcome, certainty, and optional pins.** The Run id becomes `rootExecutionId`, outcome
  and certainty pass through unchanged, and legacy references are optional (unpinnable references
  appear in `pinRefusals` without blocking import).
- **Mapping and refusal matrix (refused records write zero rows and stay recoverable):**

| Input condition | Mapping / import outcome | Rows written | Recoverability |
|---|---|---|---|
| Unsupported envelope version (`version !== 1` or non-integer) | Stored as `state: 'unsupported'`, no revision, `ownerResolution: 'live'`, `resolve`: `'unsupported-version'` (`'conflict'` over an existing non-`unsupported` handoff) | 1 `recovery_handoffs` row (idempotent) | Preserved untouched for a newer build |
| Valid non-colliding `effects.evidenceRefs` within 32 total refs | Mapped to `{ artifactId, role: 'evidence', required: false }` alongside `validated` (`upstreamArtifactRefs`) and `partial` (`partialArtifactRefs`) | Standard handoff + revision + references | Normal durable handoff |
| Total mapped references > 32 (`MAX_LEGACY_MAPPED_REFERENCES`) | Refused `{ ok: false, code: 'over-limit', field: 'references' }` | 0 | Source record untouched and recoverable |
| Unmappable `evidenceRefs` or out-of-grammar artifact IDs (outside `LIFECYCLE_OPAQUE_ID_PATTERN`) | Refused `{ ok: false, code: 'invalid-ref', field: 'references.<index>.artifactId' }` | 0 | Source record untouched and recoverable |
| Duplicate artifact IDs across/within `upstreamArtifactRefs`, `partialArtifactRefs`, `evidenceRefs` | Refused `{ ok: false, code: 'invalid', field: 'references.<index>.artifactId' }` | 0 | Source record untouched and recoverable |
| Inconsistent `workspace.coverage === 'complete'` with `workspace.omittedCount > 0` | Refused `{ ok: false, code: 'invalid', field: 'coverage' }` | 0 | Source record untouched and recoverable |
| Post-mapping manifest exceeds 16,384 UTF-8 bytes (`MAX_HANDOFF_MANIFEST_BYTES`) | Refused `{ ok: false, code: 'over-limit', field: 'manifest' }` | 0 | Source record untouched and recoverable |
| `legacyProvenance` exceeds 2,048 UTF-8 bytes | Refused `{ ok: false, code: 'over-limit', field: 'legacyProvenance' }` | 0 | Source record untouched and recoverable |
| Invalid record fields or malformed `version: 1` envelope | Refused `{ ok: false, code: 'invalid', field: '<field>' }` | 0 | Source record untouched and recoverable |

- **Stored provenance and explicit ACP session mapping (`16-12`).** Backend/runtime attribution and
  any `providerSessionId` are recorded in `legacy_provenance` only. On `recordIntent`, prior
  session source is derived from stored `handoff.legacyProvenance`, never trusting caller-supplied
  `priorSession.source = 'acp'`:
  - Ephemeral bridge session IDs (`/^acp-(?:claude|codex|agy)-session-\d+$/`) are always refused
    for `load-session` and forced to `fresh-session` (`legacy-session`).
  - Malformed `legacy_provenance` JSON or `priorSession.sessionId === providerSession.value`
    always forces `fresh-session` (`legacy-session`).
  - Any legacy-originated handoff (`legacyProvenance !== null`) fails closed unconditionally to
    `fresh-session` (`legacy-session`) whenever stored `providerSessionId` is `null` or
    `acpSessionBindings` is unwired. Allowing `load-session` requires a non-null stored
    `providerSessionId`, a valid non-ephemeral explicit `priorSession.acpMapping`
    (`{ kind: 'acp-session', sessionId }`) matching `priorSession.sessionId` and distinct from
    `providerSessionId`, and a wired `AcpSessionBindingStore` (`acpSessionBindings`) holding a
    matching non-ephemeral persisted binding for the stored `providerSessionId` and canonical
    backend.

## Prune fail-safe

Both checkpoint pruning surfaces wire lazily to SQLite recovery protection in production
(`src/activation/run-safety-wiring.ts`), failing closed with `?? true` whenever the SQLite cutover
coordinator or store is unavailable:

- **Per-envelope prune (`RunCheckpointService`).** Takes an optional predicate,
  `isRecoveryEnvelopeProtected(runSegment, handoverSegment)`. In production
  (`src/activation/run-safety-wiring.ts`), this delegates to
  `sqliteCutover?.isRecoveryEnvelopeProtected(runSegment, handoverSegment) ?? true`, which runs
  `assessRecoveryEnvelopeProtection(conn, runSegment, handoverSegment)` in
  `src/services/recovery-handoff/handoff-envelope-protection.ts` (`16-11`).
- **Run-directory retention sweep (`RunCheckpointRetentionService`).** In production
  (`src/activation/run-safety-wiring.ts`), `isPinnedRun(runSegment)` combines in-memory active/paused
  run pins with `sqliteCutover?.isRecoveryRunProtected(runSegment) ?? true`, which delegates to
  `assessRunSegmentProtection(conn, runSegment)` in
  `src/services/recovery-handoff/handoff-envelope-protection.ts`. A `checkpoints/<runSegment>/`
  directory is kept whenever any open recovery handoff or active F05 protective pin maps to
  `runSegment`, or when the SQLite store is unavailable, closed, from a newer build, ambiguous, or
  throws.
- **Restart-durable SQLite lookup.** `assessRecoveryEnvelopeProtection` queries SQLite directly
  across open handoffs (`recovery_handoffs` with `state NOT IN ('consumed', 'superseded')`),
  `recovery_handoff_revisions` (`manifest_json` envelope/references and future/unreadable manifests),
  `recovery_handoff_references`, and active F05 protective pins (`artifact_references` +
  `artifact_locations`), matching normalized `safeRunSegment(...)` against `(runSegment, handoverSegment)`.
  `assessRunSegmentProtection` applies the same restart-durable SQLite lookup at the `runSegment`
  granularity.
- **Four outcomes (fail-safe `protected: true` everywhere except affirmative `unowned`):**
  - `protected` (`true`): exact match to an open handoff or active F05 protective pin.
  - `ambiguous` (`true`): lossy `safeRunSegment` collision with an open/unresolved row, or an open
    `unsupported`, future-version, revision-less, or unreadable manifest under `runSegment`.
  - `lookup-error` (`true`): SQLite store is unavailable (`null`), closed, migrated by a newer
    build, or throws during query.
  - `unowned` (`false`): healthy store affirmatively confirms zero matching open/ambiguous handoffs
    and zero active protective pins.
- **Throwing predicate & post-checkpoint prune isolation.** If no predicate is supplied, every
  envelope is kept. If a predicate throws, the envelope is kept, a fixed path-free warning
  (`checkpoint prune kept recovery envelope: protection check failed`) is logged, and the prune
  continues. `prune()` executes best-effort outside `checkpoint()`'s artifact-write `try/catch`
  (logging a fixed path-free warning on prune I/O failure) so an already-finished checkpoint
  always succeeds.
- **Partitioned eviction and absent-file hygiene.** `prune()` tracks the directory's `fileSet` so
  absent files are never unlinked and the protection predicate is only called when
  `<prefix>.recovery.json` exists. Checkpoint prefixes (`.patch`, `.json`, `.declined.json`, cap
  `20`) are partitioned from `.recovery.json` envelope prefixes so retained envelopes (for example
  `hand-*`) never displace newly written `17...-<phase>` checkpoints, while unowned envelopes past
  the per-run cap are reaped across repeated prune passes. Each envelope is at most 16 KiB.

## Deferrals

| Deferred | Owner |
|---|---|
| Webview display of handoff explanations | F12 (execution visibility) |
| Report export of handoff explanations | F11 (report exports) |
