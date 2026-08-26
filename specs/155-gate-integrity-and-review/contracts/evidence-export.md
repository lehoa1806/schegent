# Contract: Evidence export, manifest and delete

**Source item**: FR-R3-085 · **Spec**: FR-048…FR-056

## Stage-1 scope decision (taken, not deferred)

| Control | Verdict | Reason |
|---|---|---|
| Retention disclosure | Taken | Derived from constants; the recurring class is text that outruns the code |
| Export with manifest | Taken | Bounded; the manifest is the auditable artifact |
| Delete with active-writer refusal | Taken | Bounded; refusing beats racing |
| Platform permission tests | Taken | Pure verification, worth doing regardless |
| Export-side digest chain | Taken | Needs no key store; the recipient is a different party |
| Encryption at rest | **Declined** | No key source the product already has. Inventing one is a larger change than this item. Recorded as a deferral with this reason, in the form the round uses. |

## Export

```
exportRunEvidence(runId) -> { artifactPath, manifest: ExportManifest }
```

```ts
interface ExportManifest {
  readonly runId: string;
  readonly createdAt: string;                    // UTC ISO-8601
  readonly contents: readonly ManifestEntry[];   // EXACTLY what the artifact holds
  readonly deliberateOmissions: readonly { path: string; reason: string }[];
  readonly chain: readonly ChainLink[];
}
interface ManifestEntry { readonly path: string; readonly bytes: number; readonly digest: string }
interface ChainLink { readonly entryIndex: number; readonly digest: string; readonly previousDigest: string | null }
```

**Bidirectional check.** A file in the artifact absent from `contents` fails; a `contents` entry absent
from the artifact fails. An export whose contents are not enumerated is a leak the exporter cannot audit.

**Omissions are enumerated, not silent.** Anything deliberately left out carries a reason — that is the
half the item calls the point.

**Chain is export-side only.** Link *n* carries the digest of link *n−1*; the first carries `null`. This
lets a recipient detect a modified export. It asserts nothing about the on-disk log, and **no
tamper-proofing is claimed for on-disk evidence** — a local file under the operator's own authority is
not tamper-proof and a chain on disk does not make it so.

**Redaction floor.** The export redacts at least as much as `SECRET_PATTERNS`. More is fine; less is
forbidden, and the redaction set is never weakened to make export easier.

## Delete

```
deleteRunEvidence(runId) ->
  | { outcome: 'refused', reason: 'active-writer', artifact: string }
  | { outcome: 'completed', removed: string[], retained: { path: string, reason: string }[] }
```

- **Refuses rather than races.** A run whose evidence still has an open writer is refused, and the
  refusal names the artifact.
- **Reports both sides.** A partial completion says what it removed *and* what it could not — never
  best-effort silence.
- Routes through the existing containment oracle; no path escapes the workspace root.

## Retention disclosure

Derived, never transcribed:

| Bound | Constant |
|---|---|
| Audit rotation age | `DEFAULT_AGE_MS` |
| Audit rotation size | audit writer default size |
| Checkpoint age | `CHECKPOINT_MAX_AGE_MS` |
| CLI transport cap | `CLI_TRANSPORT_MAX_BYTES` |
| Audit payload cap | `AUDIT_PAYLOAD_MAX_BYTES` |

A gate compares the disclosure text against the constants and fails on disagreement.

## Platform permission tests

Assert the modes the platform **actually produces** for `.schegent/sessions/raw-*.log`, the sessions
directory and the checkpoint tree — not the modes requested. Non-vacuity: loosen one mode, observe red.
Platforms this checkout cannot exercise are recorded as **untested**, never as met.
