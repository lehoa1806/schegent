# Shared Contract Generation

Schegent keeps the current TypeScript contracts as the runtime source of truth,
but generated artifacts provide a reviewable bridge for the VS Code extension,
Svelte webview, future Rust desktop app, and shared engine.

## Commands

Run from `repo/`:

```bash
npm run contracts:generate
npm run contracts:generate -- --check
```

`--check` does not write files. It exits non-zero when any generated artifact is
missing or stale.

Generated artifacts:

- `src/contracts/generated/boundary-contracts.ts`
- `src/contracts/generated/schemas/*.schema.json`
- `contracts/rust/src/lib.rs`

The Rust binding is dependency-free. `cargo test` from `repo/` compiles the
contract workspace.

## Review Policy

Regenerate contracts whenever a release-boundary contract changes:

- sidebar command or host-message literals
- webview snapshot fields
- settings keys or contribution constraints
- queue or workflow state literals
- audit event taxonomy or schema version
- backend runner request/result fields
- wake-up settings, invocation records, or model literals

Generated schemas are parity artifacts only in this feature. Do not replace the
existing hand-written validators with generated validators until a later parity
feature proves the generated validator rejects and accepts the same shapes.

## Exclusions

Raw transcript bytes are not generated. They are an unredacted sink-only
diagnostic artifact and must not be surfaced to UI-facing schemas or Rust
desktop bindings.
