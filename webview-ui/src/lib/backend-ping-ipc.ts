import { CMD_PING_BACKEND } from './messages';
import type { BackendRunnerKind } from './snapshot-types';
import { postCommand, type PostCommandResult } from './vscode-api';

/** The sole webview call site for CMD_PING_BACKEND. */
export function pingBackend(runner: BackendRunnerKind): PostCommandResult {
  return postCommand(CMD_PING_BACKEND, { runner });
}
