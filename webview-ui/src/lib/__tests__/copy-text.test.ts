// FR-R3-044 — `copyText` measured 0% of 27 statements.
//
// It was reachable from the Builder's copy controls and exercised by nothing, so
// the branch that matters — the platform refusing, and the caller being told so
// — had never run in a test. Its own header says why that branch matters: "a
// copy control that reports success it did not have is worse than one that
// reports failure, because the operator walks away believing they hold the run
// id." That is the assertion this file exists to make.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../copy-text';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true
  });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard API when the platform offers one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyText('run-1234')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('run-1234');
  });

  it('reports failure rather than success when the platform rejects', async () => {
    // The branch the module's own header calls out: reporting a success it did
    // not have is worse than reporting failure, because the operator walks away
    // believing they hold the value.
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });

    await expect(copyText('run-1234')).resolves.toBe(false);
  });

  it('never throws, whatever the platform does', async () => {
    // "Resolves true or false — never throws" is the contract every caller is
    // written against; a throw here would surface as an unhandled rejection in
    // a click handler.
    setClipboard({
      get writeText() {
        throw new Error('clipboard access is a trap on this platform');
      }
    });

    await expect(copyText('x')).resolves.toBe(false);
  });

  it('falls back to the textarea path when there is no async clipboard', async () => {
    // jsdom and restricted VS Code webviews both leave navigator.clipboard
    // undefined; the fallback is what still works there, and it is the path most
    // likely to be running in production.
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    await expect(copyText('fallback-value')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('leaves no textarea behind, even when the copy fails', async () => {
    // The fallback appends a node to the body. A leaked element per failed copy
    // would accumulate silently in a long-lived webview.
    setClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true
    });
    const before = document.body.querySelectorAll('textarea').length;

    await expect(copyText('x')).resolves.toBe(false);

    expect(document.body.querySelectorAll('textarea').length).toBe(before);
  });

  it('leaves no textarea behind when the copy throws', async () => {
    setClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => {
        throw new Error('execCommand exploded');
      }),
      configurable: true
    });
    const before = document.body.querySelectorAll('textarea').length;

    await expect(copyText('x')).resolves.toBe(false);

    expect(document.body.querySelectorAll('textarea').length).toBe(before);
  });
});
