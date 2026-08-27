# Backend containment qualification — what is actually available, per backend and per platform

**Qualified**: 2026-08-27 · **Item**: `FR-R3-125` (T1469) · **Spec**: `specs/161-contained-backend-execution`
**Status**: Accepted. Re-qualify on any backend CLI major version, or on gaining a second platform.

This record answers one question: for each backend × platform cell, what is the **strongest
OS-enforced boundary actually available**, and how was that determined? It exists because
`schegent.backend.uncontainedBackends` asks an operator to accept the absence of a boundary, and an
operator cannot weigh that without knowing what the alternative would have been.

**What "contained" means here, unchanged from `FR-R3-056`:** the **operating system**, not a prompt
and not the model's own harness, decides what the process can reach. A tool allowlist the model
applies to itself is not containment, however well it works.

<!-- Source: src/services/backend-containment-policy.ts -->
<!-- Source: docs/architecture/agent-capability-posture.md -->
<!-- Source: docs/operations/untrusted-repositories.md -->

## 1. The evidence, and its limit — read this before the matrix

Every cell below was determined by **invoking the installed CLI's own `--help`** on the cycle host
and reading what it declares about its own option surface, plus checking for the presence of the
platform's sandbox binary. No live model invocation was made: the audit of 2026-08-27 did not run the
live backend canary, and this cycle did not either.

That bounds what the matrix can claim, precisely:

- **A flag's existence is verified.** If this record says a CLI has a sandbox option, that was read
  from the CLI's own help at the stated version.
- **A flag's *enforcement* is not**, except where the CLI itself names the mechanism. `codex`'s help
  says its sandbox runs commands *"under seatbelt"*, which names macOS Seatbelt; that is the CLI
  declaring its own mechanism, and it is recorded as such. Nothing else here is an enforcement claim.
- **No cell is inferred from another platform.** Windows and Linux are unverified in every cell,
  because neither is available on the cycle host. This is the declaration
  [`FR-R3-115`](../../../docs/features/round_3/DONE_115_FR-R3-115_multi_platform_evidence_without_a_remote_gate.md)
  made rather than the inference it refused to make.

## 2. The cycle host

| | |
|---|---|
| Platform | Darwin arm64, macOS 26.6.2, 10 cores |
| `claude` | 2.1.247 (Claude Code) |
| `codex` | codex-cli 0.149.0 |
| `agy` | 1.1.22 |
| Platform sandbox binary | `/usr/bin/sandbox-exec` present |
| Execution repo | `2b1736d0` on `develop`, product version `0.2.0` |

## 3. The matrix

`mechanism` values are the closed set in `src/services/backend-containment-policy.ts`, and
`tests/lint/containment-qualification-parity.test.ts` asserts this table and that code name the same
mechanism for every backend, failing in **both** directions.

| Backend | Platform | Strongest boundary Schegent requests | mechanism | Verified how |
|---|---|---|---|---|
| `codex` | darwin | `codex exec --sandbox workspace-write`, enforced by macOS Seatbelt | `codex-sandbox-workspace-write` | **Verified**: `codex exec --help` declares `-s/--sandbox` with `read-only \| workspace-write \| danger-full-access`; `codex sandbox --help` states its arguments run *"under seatbelt"*; `/usr/bin/sandbox-exec` is present. `backend-containment-policy.test.ts` reads the adapter's argv and confirms Schegent passes `workspace-write`. |
| `codex` | linux | Expected to be the same mode under Landlock/seccomp rather than Seatbelt | `codex-sandbox-workspace-write` | **Unverified.** Probe: run `codex exec --sandbox workspace-write` on a Linux host and attempt a write outside the workspace; the mode is qualified when the write is refused by the kernel. |
| `codex` | win32 | Unknown | `codex-sandbox-workspace-write` | **Unverified.** Probe: as above on Windows. Codex's own help names Seatbelt, which is macOS-only, so the Windows mechanism is not merely unverified but **unnamed** — the strongest statement available today is that Schegent passes the flag and does not know what enforces it. |
| `claude` | all | **None.** | `none` | **Verified, and it is a verified absence.** `claude --help` at 2.1.247 offers `--allowedTools`, `--disallowedTools`, `--permission-mode` and `--dangerously-skip-permissions`. Every one is a decision the model's own harness makes about its own tools. The only occurrence of the word is advisory — *"Recommended only for sandboxes with no internet access"* — the CLI asking to be **placed** in a sandbox it does not provide. |
| `agy` | all | **None requested.** `--sandbox` exists; see §4. | `none` | **Verified that the flag exists; its enforcement is unverified.** See §4, which is the substantive part of this record. |

## 4. Agy's `--sandbox`: available, not requested, and why

**This contradicts the item that filed the work.** `FR-R3-125` §1 states *"Codex has
`workspace-write`; the default backend has nothing equivalent"*, and
`backend-containment-policy.ts` classified `agy` alongside `claude`. `agy 1.1.22`'s own help
declares:

    --sandbox    Run in a sandbox with terminal restrictions enabled

So one of the two backends this product calls uncontained **does** expose a native containment mode,
and Schegent does not request it. That is the finding; recording it is more important than acting on
it, and it is recorded here rather than folded into a code comment nobody would find.

**It is not requested, and the reasons are in descending order of weight.**

1. **Its enforcement is unverified, and the phrase points the wrong way.** "Terminal restrictions" is
   consistent with a restriction the agent applies to its own shell tool — which is exactly what
   `claude --disallowedTools` already is, and which this project has never counted as containment
   (§1). Codex's help names its mechanism; Agy's does not. Requesting a flag and recording a
   mechanism for it would be asserting a boundary from a sentence in a help text.
2. **It plausibly breaks the product.** Schegent's phases run Git-capable work through the backend's
   shell; `sideEffects: git` phases are the whole reason `codex`'s `workspace-write` mode is refused
   for them (it keeps `.git` read-only). A flag that restricts the terminal may refuse the same work
   on **every** Agy run, and this cycle cannot find out without a live invocation.
3. **Doing it anyway is the overclaim pattern.** Add a flag whose effect is unknown, record a
   mechanism for it, and the product now documents a boundary that may not be there. That is the
   class `FR-R3-116`, `122`, `123`, `126` and `124` have each closed one instance of. Committing it
   inside the item that found the gap would be a poor result.

### The probe that would qualify it

Run on a host where Agy is installed and authenticated, in a scratch repository:

1. `agy --sandbox -p 'write the text ok to /tmp/agy-sandbox-probe and report what happened'`
2. Then the same prompt targeting a path outside the workspace and outside `/tmp` — a file in the
   operator's home directory that the workspace has no business touching.
3. Repeat both **without** `--sandbox`.

**Qualified when**: the out-of-workspace write succeeds without the flag and is refused **with** it,
*and* the refusal is attributable to the operating system rather than to the agent declining — which
means the refusal appears as a syscall-level error (`EPERM`/`EACCES`) in the tool output, not as the
model saying it chose not to.

**Also required before requesting the flag**: one full Schegent pipeline through a `sideEffects: git`
phase on Agy with `--sandbox`, green. Reason 2 is not hypothetical, and a containment flag that
breaks every Git-capable Run is not an improvement.

### Entry condition for requesting it

All three:

1. The probe above qualifies the mode, with its output recorded in this file's §4.
2. A `sideEffects: git` pipeline completes on `agy --sandbox`.
3. A `BackendContainmentMechanism` value is added for it that names the enforcing mechanism — not
   `agy-sandbox`, which names a flag. If the mechanism cannot be named, condition 1 was not met.

Until then `agy` maps to `none` in the one table, is refused by default, and requires an explicit
per-backend grant. **A reader who disagrees with this decision has, above, everything needed to
overturn it.**

## 5. What Schegent does with this

- The classification (`os-enforced` / `none`) drives the refusal at `createBackendRunner`. Unchanged
  by this record.
- The **mechanism** is recorded per Run in the `backend-posture-admitted` audit entry
  (`containmentMechanism`), so an operator reading evidence after the fact can see which boundary
  applied — including `none`, which is a value and not an absent field.
- The per-backend grant means accepting `agy`'s absence of a boundary does not accept `claude`'s.

## 6. What this record does not claim

- It does not claim any sandbox is escape-proof. `workspace-write` permits writing the workspace,
  which is its purpose.
- It does not claim a contained backend is safe. It can act badly inside its boundary, and prompt
  injection remains out of the host's reach — the threat model's position, unchanged.
- It does not claim any enforcement was tested live. §1 states the evidence and its limit.
- It does not claim Windows or Linux behaviour. Every non-darwin cell is marked unverified with its
  probe.
