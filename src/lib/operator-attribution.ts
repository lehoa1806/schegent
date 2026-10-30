/**
 * Feature 017 — Operator attribution helper. Feature 251 (FR-R4-F04, FR-026 to FR-029) — a pseudonym, not
 * the OS account name.
 *
 * WHAT CHANGED. This used to return `os.userInfo().username` for the `actor` field of every operator
 * -initiated audit row and every `PhaseOverride`. That put the operating-system account name, a real
 * identity, into a hash-chained evidence file that an operator is expected to export and hand to someone
 * else. It now returns the operator's PSEUDONYM: `pseudonym-<16 hex>`, drawn from 8 random bytes, created
 * once per workspace and kept in the workspace memento. The OS account is never read: this module does not
 * import `node:os`, and nothing else in `src/` calls `os.userInfo()` for attribution.
 *
 * WHAT A PSEUDONYM IS AND IS NOT. It stays the same across sessions, so rows by the same operator are
 * linkable to one another, and a reset (`schegent.resetOperatorPseudonym`) gives a new one. It names no
 * person and cannot be derived from anything on the machine. It is still metadata about who acted, which
 * `docs/reference/audit-events.md` says plainly (FR-029): rows written before this feature may still hold
 * a username, and nothing rewrites them, because rewriting would break the chain.
 *
 * HOW IT REACHES A SYNCHRONOUS CALLER. `getOperatorActor()` is called from the audit envelope and from the
 * two phase-control overrides, all synchronous, so the attribution is INSTALLED once (`installOperatorAttribution`)
 * and read per call. Before installation, and when no pseudonym is stored, it answers `unknown-operator`,
 * the same literal the v2 to v3 migrator uses for legacy overrides, so a caller that runs early gets a
 * value every reader already accepts. Creation is a separate, awaited step (`ensureStored`) that the trust
 * -gated producer preamble runs, because it is a write to workspace state and an untrusted window only reads.
 */

/** The literal for "no pseudonym": before installation, in an untrusted window, or when the store failed. */
export const UNKNOWN_OPERATOR = 'unknown-operator';

export const PSEUDONYM_PREFIX = 'pseudonym-';

const PSEUDONYM_BYTES = 8;
const PSEUDONYM_PATTERN = /^pseudonym-[0-9a-f]{16}$/;
const STORED_VERSION = 1;

/** Whether `value` is a pseudonym this module could have generated. */
export function isOperatorPseudonym(value: unknown): value is string {
  return typeof value === 'string' && PSEUDONYM_PATTERN.test(value);
}

/** The memento's two methods, so this module imports neither the store nor VS Code. */
export interface OperatorAttributionStore {
  readOperatorPseudonym(): unknown;
  writeOperatorPseudonym(value: { readonly version: 1; readonly pseudonym: string }): Promise<void>;
}

export interface OperatorAttribution {
  /**
   * The pseudonym stored right now, or `unknown-operator` when none valid is. Reads the store on every
   * call and creates nothing, so it is safe in an untrusted window and always current after a reset.
   */
  current(): string;
  /** The stored pseudonym; creates and stores one when it is missing or invalid. A failed store answers `unknown-operator`. */
  ensureStored(): Promise<string>;
  /** Replaces the pseudonym with a new one. Rejects if it cannot be stored, leaving the old one in place. */
  reset(): Promise<string>;
}

function storedPseudonym(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { version?: unknown; pseudonym?: unknown };
  return candidate.version === STORED_VERSION && isOperatorPseudonym(candidate.pseudonym) ? candidate.pseudonym : null;
}

export function createOperatorAttribution(
  store: OperatorAttributionStore,
  randomBytes: (size: number) => Uint8Array
): OperatorAttribution {
  const generate = (): string => `${PSEUDONYM_PREFIX}${Buffer.from(randomBytes(PSEUDONYM_BYTES)).toString('hex')}`;
  const current = (): string => storedPseudonym(store.readOperatorPseudonym()) ?? UNKNOWN_OPERATOR;
  return {
    current,
    async ensureStored(): Promise<string> {
      const existing = storedPseudonym(store.readOperatorPseudonym());
      if (existing !== null) return existing;
      const created = generate();
      try {
        await store.writeOperatorPseudonym({ version: STORED_VERSION, pseudonym: created });
      } catch {
        // Nothing is persisted, so nothing is attributed to a value that would not survive a restart.
        return UNKNOWN_OPERATOR;
      }
      return created;
    },
    async reset(): Promise<string> {
      const created = generate();
      await store.writeOperatorPseudonym({ version: STORED_VERSION, pseudonym: created });
      return created;
    }
  };
}

let installed: Pick<OperatorAttribution, 'current'> | null = null;

/** Install the attribution `getOperatorActor()` reads, or `null` to clear it (tests). */
export function installOperatorAttribution(attribution: Pick<OperatorAttribution, 'current'> | null): void {
  installed = attribution;
}

/** The actor id for an operator-initiated row or override: the installed pseudonym, else `unknown-operator`. */
export function getOperatorActor(): string {
  return installed?.current() ?? UNKNOWN_OPERATOR;
}
