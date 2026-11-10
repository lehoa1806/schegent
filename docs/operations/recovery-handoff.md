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
- [`src/services/recovery-handoff/handoff-resolver.ts`](../../src/services/recovery-handoff/handoff-resolver.ts)
- [`src/services/recovery-handoff/delivery-policy.ts`](../../src/services/recovery-handoff/delivery-policy.ts)
- [`src/services/recovery-handoff/session-plan.ts`](../../src/services/recovery-handoff/session-plan.ts)
- [`src/services/recovery-handoff/handoff-explanation.ts`](../../src/services/recovery-handoff/handoff-explanation.ts)
- [`src/services/recovery-handoff/legacy-handoff-mapping.ts`](../../src/services/recovery-handoff/legacy-handoff-mapping.ts)
- [`src/services/run-checkpoint-service.ts`](../../src/services/run-checkpoint-service.ts), the prune fail-safe

## Production status

What ships and runs in this release:

- **The prune fail-safe.** A checkpoint prune keeps every `.recovery.json` envelope (see
  [Prune fail-safe](#prune-fail-safe)).

What ships but production does not construct yet:

- **The handoff service and its five tables.** Migration 5 creates the tables in every store
  that is opened. Production opens no application store in the extension host until the F01-B
  cutover, so no handoff, pin, intent or decision is written yet. The service is qualified
  against a file-backed store that is closed and reopened at every seam, as F05 to F07 were.
- **Delivery.** It goes through a port the ACP runtime (F13) will implement. Tests use a fake.
- **The explanation.** It is a host product with no webview surface in this release.

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

`resolve(handoffId, revisionNo?)` checks each reference of a revision against the F05 record,
and against the bytes when a digest is expected. Each result is stored on the reference row, so
an explanation reports it without probing again. The artifact locator never leaves the host.

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
- **Order.** Deliveries and decisions are listed newest first, so trimming drops the oldest.
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

`importLegacy(record)` maps a record captured before the cutover:

- Its ids are kept. The Run id becomes the root execution id.
- Outcome and certainty are unchanged.
- A `paused` record is paused after it is prepared.
- The backend and runtime attribution, and any provider session id, go into the provenance
  only. A provider session id is never treated as an ACP session id: continuation plans a fresh
  session unless the caller supplies an explicit ACP session mapping.
- Legacy references are optional. One that cannot be pinned is reported in `pinRefusals`.

An envelope of an unknown version is stored as an `unsupported` handoff with no revision. It
stays `live` to the owner resolver and resolves `unsupported-version`. Importing it again
returns the same row. Importing it under the lineage of a handoff that is not `unsupported` is
`conflict`. An invalid record writes nothing and names the field.

## Prune fail-safe

`RunCheckpointService` takes an optional predicate,
`isRecoveryEnvelopeProtected(runId, handoverId)`. When a checkpoint prune evicts a handover, its
`.recovery.json` envelope is removed only if a predicate is wired and returns `false`. With no
predicate, which is production today, every envelope is kept. A predicate that throws counts as
protecting the envelope: the envelope is kept, a warning without the error text is logged, and
the checkpoint still completes. The other files of the evicted handover (`.patch`, `.json`,
`.declined.json`) are pruned as before. Each envelope is at most 16 KiB.

The predicate receives the stored path segments: the Run's directory name and the handover's
file prefix. UUID Run ids and opaque handover ids pass through unchanged.

## Deferrals

| Deferred | Owner |
|---|---|
| Composing the service into the production execution path (FR-003), and wiring the prune predicate | F01-B |
| The ACP runtime, its session loading and delivery port | F13 |
| The legacy drain run and removal of the legacy store (FR-019) | F13, F01-B |
| Showing the explanation in the product | F12 (execution visibility) |
| Exporting the explanation | F11 (report exports) |
