# Declined: an encrypted evidence store

Status: **Declined, with a reversal trigger.** Recorded 2026-08-27 · Item: `FR-R3-127` (T1482)
Spec: `specs/163-evidence-privacy-profiles`

Decision: Schegent does **not** encrypt its local evidence store, and will not until two named things
exist — a **named threat model** the encryption answers, and a **named key-management owner**.

This is recorded rather than left to be rediscovered. It has been raised twice: `FR-R3-085` stage 1
declined optional encryption for a stated reason, and the repository audit of 2026-08-27 restated the
condition in its own words: an encrypted evidence store *"should be justified by a named threat model
and key-management owner; encryption without a usable key lifecycle would add false assurance."*

<!-- Source: docs/operations/evidence-retention-disclosure.md -->
<!-- Source: docs/reference/settings.md -->
<!-- Source: src/contracts/privacy-profiles.ts -->

## 1. What is currently protected, and how

| Control | What it does |
|---|---|
| POSIX owner-only modes | Evidence files are readable by the account that wrote them (`FR-R3-050`) |
| Path containment | Every evidence write resolves through the containment oracle, so a planted symlink cannot redirect it (`FR-R3-005`, `FR-R3-053`) |
| `.gitignore` | Keeps evidence out of commits — and **nothing else**; it does not stop backup or sync tooling |
| Retention sweeps | Bound how long and how much is held (`FR-R3-012`, `FR-R3-050`) |
| Redaction | Applies to the structured audit log and the sanitized transport log; the raw transcript is deliberately unredacted, which is what makes it raw |
| Privacy profiles | Let an operator choose how much unredacted evidence is kept at all (`FR-R3-127`) |
| Export and delete | `Schegent: Export Run Evidence` and `Schegent: Delete Run Evidence` (`FR-R3-085`, wired by `FR-R3-127`) |

The threat this stack does **not** answer is an actor who can read the operator's own files.

## 2. Why encryption is declined rather than deferred

The distinction matters: deferred means "not yet, no reason needed"; declined means "not without
these two things, and here they are".

**There is no key store, and inventing one is the whole problem.** Encryption at rest is not the hard
part; the key lifecycle is. Every option this product could take today fails in a way that leaves the
operator worse off than the honest unencrypted store:

- **A key derived from a passphrase the operator types.** Schegent runs unattended — that is its
  purpose. A passphrase prompt on every Run defeats it; a passphrase cached for the session is a key
  in the same process that writes the plaintext.
- **A key in the OS keychain.** Reachable by any process running as that operator, which is precisely
  the actor the encryption would claim to stop. It also makes evidence unreadable after an OS
  reinstall, which turns a privacy feature into data loss.
- **A key file beside the store.** A lock with the key taped to it. It would still let a document say
  "encrypted at rest", which is the worst outcome of the three.
- **An external KMS.** A network dependency in a local-first product, and a second party to the
  operator's evidence. It also needs an owner, which is condition two.

**And the actor it would stop is not the actor in the threat model.** An uncontained backend runs
under the operator's own authority (`FR-R3-125`); a process with that authority can read a key the
same process must be able to read. Encryption against that actor is theatre.

**What it would buy is real but narrow**: an offline disk, a stolen laptop, or a backup snapshot read
by someone without the operator's session. Those are worth answering — by full-disk encryption, which
every supported platform already provides and which has a key lifecycle someone else owns. That is
the honest recommendation and it is in the operator documentation rather than in this product.

## 3. The reversal trigger

This declination reverses when **both** exist, named, in writing:

1. **A threat model naming the actor.** Not "someone who gets the disk" but a specific actor with a
   specific access this product's other controls do not already answer — and an argument for why
   platform full-disk encryption does not cover them.
2. **A key-management owner.** A person or team answerable for generation, storage, rotation,
   recovery, and destruction, plus a written answer to "what happens to an operator's evidence when
   the key is lost". Without that answer, encryption converts a privacy problem into a data-loss
   problem and calls it an improvement.

Either alone is insufficient, and the reason is the audit's: *encryption without a usable key
lifecycle would add false assurance*. A product that says "encrypted at rest" and cannot say by which
key, held by whom, recoverable how, has made its documentation less true, not its evidence safer.

**Earlier, weaker triggers that do NOT reverse this**: a request for encryption without a threat
model; a compliance checklist naming encryption-at-rest generically; the availability of a library.

## 4. What this record does not claim

- It does not claim the evidence store is safe against an actor with the operator's file authority. It
  claims encryption would not change that, and says why in §2.
- It does not claim encryption is a bad idea. It claims it is not a decision this product can take
  without an owner for the keys.
- It does not claim the current controls are sufficient for every audience. That is what the privacy
  profiles are for, and `ephemeral` exists because they are not.
- It does not claim tamper-evidence. The audit chain detects modification and does not prevent it
  (`FR-R3-116`); a hash chain on the same disk as the log is not nonrepudiation.
