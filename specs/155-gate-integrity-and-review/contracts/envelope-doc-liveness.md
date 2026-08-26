# Contract: Envelope document source-path liveness

**Source item**: FR-R3-094 · **Spec**: FR-018, FR-019

## Why the existing link gate cannot do this

`repo/scripts/check-doc-links.mjs` resolves **Markdown links**. The envelope documents cite
implementation sources as **backticked prose paths** — `` `src/config/phase-precedence.ts` `` — which no
link checker sees. That gap is why this class has now been filed four times (`R-14`, `D2`, `F-08`, and
the envelope half). The gate closes the gap for the two workspace documents that make such citations.

## Registered surfaces

```
ARCHITECTURE.md
docs/security/threat-model.md
```

Registration is what makes a document checked. Adding one is proven to have effect by adding one.

## The rule

For every backticked span in a registered document that **looks like an implementation source path** —
matching `^(src|webview-ui/src|tests|scripts)/[\w./-]+\.(ts|mts|mjs|js|svelte|json)$` — the gate resolves
it against `repo/`. A span that does not resolve fails, naming the document, the line and the path.

Spans that are not source paths (settings ids, flags, command names, JSON keys) are not matched by the
pattern and are not claims this gate makes. **The gate prints how many spans it checked**, so a clean run
cannot be read as a clean sweep of everything backticked.

## Threat-model parity

A second assertion binds the envelope threat model to `repo/`'s:

1. `grep -ciE "codex|agy|allowUncontainedBackends"` over the envelope threat model is **non-zero**.
2. The containment asymmetry it states matches `repo/`'s threat model: `codex` contained,
   `claude` and `agy` uncontained, with the opt-in setting named.

`repo/`'s document is the single authority for the backend posture; the envelope one states
workspace-level trust boundaries and cites it. **No third threat model is created.**

## Non-vacuity

- Introduce a dead backticked source path into a registered document → red, naming the path. Revert → green.
- Remove the backend names from the envelope threat model → red. Restore → green.

## Out of scope, deliberately

`docs/architecture/blueprint.md` is **not** registered and **not** edited. A prior verification cleared
it because it self-dates with a named derivation commit, and touching it would re-introduce an overclaim
that verification already removed. The same applies to the two spans in `ARCHITECTURE.md` that the same
verification cleared: the three-backend section and the staleness-threshold citation.
