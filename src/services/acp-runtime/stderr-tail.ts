/**
 * FR-R6-F13 (FR-017, research R7) — the agent's stderr, kept apart from the protocol.
 *
 * Only the newest bytes up to the bound are kept. `text()` decodes them leniently (the window
 * may begin inside a character) and removes C0, DEL and C1 control characters other than newline
 * and tab, so terminal escapes and bells never reach a diagnostic surface. Stderr is never parsed
 * as protocol and never logged by the runtime. Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS } from '../../contracts/acp-runtime';

const TAB = 0x09;
const NEWLINE = 0x0a;
const LAST_C0 = 0x1f;
const DEL = 0x7f;
const LAST_C1 = 0x9f;

function isRemovedControl(code: number): boolean {
  if (code === TAB || code === NEWLINE) return false;
  return code <= LAST_C0 || (code >= DEL && code <= LAST_C1);
}

export class StderrTail {
  private bytes: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxBytes: number = ACP_RUNTIME_LIMITS.stderrTailBytes) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.maxBytes) {
      this.bytes = chunk.slice(chunk.byteLength - this.maxBytes);
      return;
    }
    const keep = Math.min(this.bytes.byteLength, this.maxBytes - chunk.byteLength);
    const next = new Uint8Array(keep + chunk.byteLength);
    next.set(this.bytes.subarray(this.bytes.byteLength - keep), 0);
    next.set(chunk, keep);
    this.bytes = next;
  }

  text(): string {
    let kept = '';
    for (const character of new TextDecoder('utf-8').decode(this.bytes)) {
      if (!isRemovedControl(character.codePointAt(0) ?? 0)) kept += character;
    }
    return kept;
  }
}
