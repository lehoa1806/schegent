/**
 * FR-R6-F13 — the ACP runtime surface: open one connection to one agent process over a
 * transport, the stdio transport that launches it, and the F02 envelope for each observation.
 * Types are in `src/contracts/acp-runtime.ts`. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export { openAcpConnection } from './acp-client';
export { toSharedAcpEnvelope } from './shared-envelope';
export { spawnStdioTransport, type StdioLaunch } from './stdio-transport';
export { SYSTEM_CLOCK } from './system-clock';
