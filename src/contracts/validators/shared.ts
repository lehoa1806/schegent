import type { SidebarCommand } from '../sidebar-ipc';

export interface IpcValidationError {
  readonly ok: false;
  readonly reason: string;
  readonly type?: string;
  readonly correlationId?: string;
}

export type IpcValidationResult =
  | { readonly ok: true; readonly command: SidebarCommand }
  | IpcValidationError;

export const CORRELATION_ID_MAX = 64;
export const QUEUE_ID_MAX = 256;

export function ok(command: SidebarCommand): IpcValidationResult {
  return { ok: true, command };
}

export function fail(
  reason: string,
  extra: { type?: string; correlationId?: string } = {}
): IpcValidationError {
  return { ok: false, reason, ...extra };
}

export function hasUnexpectedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return true;
  }
  return false;
}
