/**
 * Feature 097 — extract "HH:MM" from an ISO timestamp for the Queue Detail
 * tier's secondary time label.
 *
 * `formatRelativeTime` returns "Xm ago" style; `formatAbsoluteTime` returns a
 * full datetime string. The mockup wants a compact absolute label like
 * "started 14:02", so this helper fills the gap. The phase log's lines pass
 * `seconds` for the redesign's "14:02:11", since entries arrive seconds apart.
 *
 * Local time; an empty string for a value that does not parse.
 */
export function formatTimeOfDay(iso: string, options: { readonly seconds?: boolean } = {}): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (options.seconds !== true) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
