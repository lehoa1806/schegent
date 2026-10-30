// FR-R4-F04 (FR-034, FR-035, B2, B5; data-model §8) — what a diagnostics bundle will hold, decided from
// sizes alone.
//
// WHY A PLAN BEFORE A READ. The operator is shown every item the bundle will include and every item it will
// leave out, each with its share or its reason, BEFORE anything is read beyond a size (B2). So the plan is a
// pure function of probes (does this item exist, how big is it) and one choice (include raw conversation or
// not). It reads nothing, which is what lets `bundle.test.ts` assert "the plan lists everything before any
// read" by giving it probes and nothing else.
//
// THE DEFAULT HOLDS NO RAW CONVERSATION (FR-035). The raw transcript, the transport and the verbose
// diagnostic tree (`stream.jsonl` is the CLI stream; `debug.json` and `verbose.log` are unredacted) hold the
// operator's prompts, source and model output. They are omitted unless the operator opts in per bundle, and
// the omission reason says how to get them. A bundle is shared: the safe default is the one that needs no
// reading of it before it is sent.
//
// SHARES SUM TO THE LIMIT. Each item has a share of the serialized bytes; the five default items and the
// three raw items together add up to exactly `DIAGNOSTICS_BUNDLE_MAX_BYTES`, so a bundle that fills every
// share is at the limit and the writer's shrink step only has to absorb the JSON framing.

/** The most a serialized bundle may be (data-model §8): 10 MiB. */
export const DIAGNOSTICS_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

const KIB = 1024;
const MIB = 1024 * KIB;

export const BUNDLE_ITEM_IDS = [
  'host',
  'run-status',
  'failure-records',
  'audit-rows',
  'runtime-log',
  'raw-transcript',
  'transport',
  'verbose-diagnostics'
] as const;
export type BundleItemId = (typeof BUNDLE_ITEM_IDS)[number];

/** The three items that hold raw conversation, omitted unless the operator includes them. */
export const RAW_BUNDLE_ITEMS: readonly BundleItemId[] = ['raw-transcript', 'transport', 'verbose-diagnostics'];

/** Each item's share of the serialized bytes. The three raw items share 3 MiB between them. */
export const BUNDLE_ITEM_SHARES: Readonly<Record<BundleItemId, number>> = Object.freeze({
  host: 64 * KIB,
  'run-status': 256 * KIB,
  'failure-records': 704 * KIB,
  'audit-rows': 3 * MIB,
  'runtime-log': 3 * MIB,
  'raw-transcript': 1 * MIB,
  transport: 1 * MIB,
  'verbose-diagnostics': 1 * MIB
});

export const RAW_OMISSION_REASON = 'raw conversation; include it explicitly';
export const NOTHING_RECORDED_REASON = 'nothing recorded for this Run';

/** What the plan needs to know about one item: whether it exists for the Run, and how many bytes. */
export interface BundleProbe {
  readonly item: BundleItemId;
  readonly available: boolean;
  readonly bytes: number;
}

export interface PlannedItem {
  readonly item: BundleItemId;
  /** The most this item may serialize to. */
  readonly share: number;
  /** What the probe found; the item is truncated from the front when this exceeds `share`. */
  readonly foundBytes: number;
}

export interface OmittedItem {
  readonly item: BundleItemId;
  readonly reason: string;
}

export interface BundlePlan {
  readonly included: readonly PlannedItem[];
  readonly omitted: readonly OmittedItem[];
  /** One line per item, included first, for the preview QuickPick. */
  readonly previewRows: readonly string[];
}

const formatBytes = (bytes: number): string => {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= KIB) return `${Math.round(bytes / KIB)} KiB`;
  return `${bytes} B`;
};

/**
 * Plan a bundle from probes. An item with no probe is treated as not available, so a probe a caller forgot
 * to take reads as "nothing recorded" and is listed, not silently absent.
 */
export function planBundle(probes: readonly BundleProbe[], includeRaw: boolean): BundlePlan {
  const byItem = new Map(probes.map((probe) => [probe.item, probe]));
  const included: PlannedItem[] = [];
  const omitted: OmittedItem[] = [];
  for (const item of BUNDLE_ITEM_IDS) {
    const raw = RAW_BUNDLE_ITEMS.includes(item);
    if (raw && !includeRaw) {
      omitted.push({ item, reason: RAW_OMISSION_REASON });
      continue;
    }
    const probe = byItem.get(item);
    if (probe === undefined || !probe.available) {
      omitted.push({ item, reason: NOTHING_RECORDED_REASON });
      continue;
    }
    included.push({ item, share: BUNDLE_ITEM_SHARES[item], foundBytes: probe.bytes });
  }
  const previewRows = [
    ...included.map(
      (entry) =>
        `Include ${entry.item}: ${formatBytes(entry.foundBytes)} found, at most ${formatBytes(entry.share)}` +
        (entry.foundBytes > entry.share ? ' (the oldest content is cut)' : '')
    ),
    ...omitted.map((entry) => `Omit ${entry.item}: ${entry.reason}`)
  ];
  return Object.freeze({ included, omitted, previewRows });
}
