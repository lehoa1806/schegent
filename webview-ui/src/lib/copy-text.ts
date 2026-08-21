// Feature 103 (T056) — copy a short string to the clipboard, and say whether
// it worked.
//
// T056 names `lib/action-copy.ts` as the helper to reuse. That module is the
// confirmation-copy table (`ActionKey` -> title/body for the confirm modal) and
// has nothing to do with the clipboard; there was no shared clipboard module to
// reuse, only the idiom inlined in `PhaseLogFeed/parts/MultiLineCodeBlock.svelte`.
// This is that idiom, extracted, so the second caller does not become a second
// copy of it. `MultiLineCodeBlock` is deliberately left as it is — rewriting a
// working component in another feature's story is a change nobody asked for.
//
// The two paths exist because the webview is not always allowed the async API:
// a restricted VS Code webview and jsdom both leave `navigator.clipboard`
// undefined, and the textarea fallback is what still works there.

/**
 * Write `text` to the clipboard.
 *
 * Resolves `true` on success and `false` when the platform refused — never
 * throws. The caller renders the difference: a copy control that reports
 * success it did not have is worse than one that reports failure, because the
 * operator walks away believing they hold the run id.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return copyViaTextarea(text);
  } catch {
    // Non-fatal, and deliberately not logged: the only interesting fact is the
    // `false`, and the rejection reason is a platform string with nothing in it
    // for an operator.
    return false;
  }
}

function copyViaTextarea(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
}
