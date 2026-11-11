/**
 * FR-R6-F13 — the ACP runtime surface: open one connection to one agent process over a
 * transport, the stdio transport that launches it, built-in agent profiles and maintained stdio
 * bridges, and the F02 envelope for each observation.
 * Types are in `src/contracts/acp-runtime.ts`. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export { openAcpConnection } from './acp-client';
export {
  ACP_STDIO_BRIDGE_VERSION,
  parseBridgeCliArgv,
  startAcpStdioBridgeServer,
  type AcpBridgeLaunchConfig,
  type BridgeIoStreams,
  type BridgeServerHandle,
  type BridgedBackendKind
} from './bridges/acp-stdio-bridge';
export {
  ACP_PROFILE_IDS,
  acpQualificationForPlatform,
  defaultAcpBridgeScriptPath,
  getBuiltinAcpProfile,
  listBuiltinAcpProfiles,
  resolveAcpProfileLaunch,
  type AcpProfilePlatform,
  type BuiltinAcpProfileId,
  type ResolveAcpProfileLaunchInput
} from './profiles';
export { toSharedAcpEnvelope } from './shared-envelope';
export {
  spawnManagedCliChild,
  spawnStdioTransport,
  type AcpStdioTransport,
  type ManagedCliChild,
  type ManagedCliExit,
  type StdioLaunch
} from './stdio-transport';
export { SYSTEM_CLOCK } from './system-clock';
