# What Schegent keeps on this machine

**Audience**: any operator running Schegent. **Status**: derived — see below.

Schegent writes evidence to your workstation and nowhere else. This page says what it writes, where,
whether the content is redacted, and for how long. It exists because `PRIV-01` found there was no
moment at which an operator was told any of that.

## Derived, not written

**Every bound in the table below is read from the constant that enforces it**, by
`repo/src/services/retention-disclosure.ts`. There is no second number to keep in step, and
`repo/tests/lint/retention-disclosure-parity.test.ts` fails if this document and those constants
disagree.

That mechanism is the point. This class of defect recurred three times in this round — operator-facing
text asserting a property nothing checks — and each previous fix was an edit, after which the text
drifted again.

## What is kept

| Artifact | Location | Content | Bound | Derived from |
|---|---|---|---|---|
| Structured audit log | `.schegent/audit.log (plus timestamped rotations)` | redacted | rotates at 5 MiB or 30 days, whichever comes first | `AUDIT_ROTATION_DEFAULT_SIZE_BYTES / AUDIT_ROTATION_DEFAULT_AGE_MS in src/audit/audit-log-writer.ts` |
| Audit event payload | `inside each audit entry` | redacted | each payload is truncated above 32 KiB | `AUDIT_PAYLOAD_MAX_BYTES in src/audit/audit-payload.ts` |
| Raw session transcript | `.schegent/sessions/raw-<runId>.log` | **not redacted** | kept for `always`, or promoted for a non-clean Run under `errors-only`; governed by the session-retention settings | `src/audit/raw-transcript-writer.ts; schegent.logging.* settings` |
| CLI transport generations | `.schegent/sessions/` | redacted | bounded at 5 MiB | `CLI_TRANSPORT_MAX_BYTES in src/monitor/cli-transport-sink.ts` |
| Export of a run's evidence | `the directory you choose when you run the export` | redacted | each artifact is carried up to 16 MiB; anything larger is omitted and the manifest says which and why | `MAX_ARTIFACT_BYTES in src/services/evidence-export.ts` |
| Private recovery checkpoints | `the extension's globalStorage — deliberately outside the workspace` | **not redacted** | 14 days and 256 MiB total, with the 10 most recent Run directories protected from the size limit | `CHECKPOINT_MAX_AGE_MS / CHECKPOINT_MAX_TOTAL_BYTES / CHECKPOINT_RECENT_RUN_FLOOR in src/services/run-checkpoint-retention.ts` |

## The one artifact that is deliberately unredacted

`.schegent/sessions/raw-<runId>.log` holds the backend's output **verbatim**. That is the threat
model's stated position, not an oversight: it is a developer-debug artefact, comparable to terminal
scrollback, never read back by the host, never shipped to a webview, and gitignored. If your prompts
or your repository contain secrets, that file can contain them too.

It is the reason this page exists rather than a reason it does not.

**The export is the exception, and deliberately so.** An export crosses a trust boundary that a local
file does not — someone else receives it — so every artifact is redacted on the way out, including
this one. Redacting more than the product's own set is fine; redacting less is not.

## Errors-only remains the default

This page describes what is **retained**. It does not change what is **captured**: the default session
retention is `errors-only`, and nothing in `FR-R3-085` alters it.

## What you can do about it

| Want to | Command |
|---|---|
| See what is held for a Run | `Schegent: Export Run Evidence` — writes an archive plus a manifest of exactly what it contains and what it deliberately omits |
| Remove what is held for a Run | `Schegent: Delete Run Evidence` — reports what it removed **and** what it could not, and refuses rather than racing a live writer |

## What this page does not claim

- **On-disk evidence is not tamper-proof.** These are files under your own account's authority. A
  hash chain on disk would not change that, so none is claimed. The export carries a chain because
  its recipient is a different party — that is where a chain means something.
- **Nothing here is encrypted at rest.** `FR-R3-085` stage 1 declined optional encryption for a
  stated reason: this product has no key store, and inventing one is a larger change than that item.
  `FR-R3-127` turned that into a record with a reversal trigger —
  [the evidence-encryption declination](../architecture/evidence-encryption-declination.md) — so the
  question is answered rather than re-asked. The short version: encryption's hard part is the key
  lifecycle, and the actor it would stop is one that already has the authority to read the key.
- **Which posture you are in is a choice with a name.** `FR-R3-127` publishes three privacy profiles
  — `ephemeral`, `diagnostic` (these defaults) and `forensic` — each stating what it keeps, who it is
  for, and what it does **not** change. See [the settings reference](../reference/settings.md).
  The decline is recorded with its reason rather than omitted.
