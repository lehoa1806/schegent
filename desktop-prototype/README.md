# Schegent Desktop Prototype

This crate is a non-production Rust-owned prototype shell. It validates the
desktop direction without running autonomous workflows, installing schedulers,
or writing `.schegent/` workspace state.

What it proves:

- shared Svelte UI bundle path handling
- explicit workspace selection and recent workspace tracking
- host-message and command-acknowledgement shapes using generated contract
  literals
- visible rejection of unsupported commands

What it does not do:

- no native webview/Tauri packaging yet
- no real workflow execution
- no wake-up scheduler installation
- no raw transcript or diagnostic file reads

Run from `repo/`:

```bash
cargo test
npm run build:webview
cargo run -p schegent-desktop-prototype -- dist/webview/index.html
```
