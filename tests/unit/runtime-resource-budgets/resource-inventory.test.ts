import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
  PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
  PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
  RESOURCE_COLLECTOR_MAX_BYTES,
  RESOURCE_COLLECTOR_MAX_SAMPLES
} from '../../../src/contracts/runtime-resource-budgets/common-bounds';
import { ROUND6_FEATURE_CONSUMER_MAPPING } from '../../../src/contracts/shared-memory-storage/consumer-and-retention-inventories';
import {
  AUTHORITATIVE_CONSTANT_VALUES,
  RUNTIME_RESOURCE_INVENTORY,
  reviewDiagnosticCollectorProposal,
  validateResourceInventory,
  type InventoryEntry
} from '../../../src/services/runtime-resource-budgets/resource-inventory';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('RUNTIME_RESOURCE_INVENTORY (T008, T009, T010, T011, SC-001)', () => {
  it('passes inventory validation with zero competing constants and complete target entries', () => {
    const result = validateResourceInventory();
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('verifies every owner path and authority module exists on disk and private symbols appear in source', () => {
    for (const entry of RUNTIME_RESOURCE_INVENTORY) {
      const ownerPath = path.join(REPO_ROOT, entry.owner);
      expect(fs.existsSync(ownerPath), `Missing owner file for ${entry.id}: ${entry.owner}`).toBe(
        true
      );

      if (entry.limit.kind === 'authority' || entry.limit.kind === 'authority-private') {
        const modPath = path.join(REPO_ROOT, entry.limit.module);
        expect(
          fs.existsSync(modPath),
          `Missing authority module for ${entry.id}: ${entry.limit.module}`
        ).toBe(true);
        const source = fs.readFileSync(modPath, 'utf8');
        const re = new RegExp(`\\bconst\\s+${entry.limit.symbol}\\b`);
        expect(
          re.test(source),
          `Symbol ${entry.limit.symbol} not found in ${entry.limit.module}`
        ).toBe(true);
      }
    }
  });

  it('rejects missing attributes, duplicate ids, competing constants, and un-remediated unbounded findings', () => {
    const base = RUNTIME_RESOURCE_INVENTORY[0]!;
    const duplicate = [base, base];
    expect(validateResourceInventory(duplicate).ok).toBe(false);

    const competing: InventoryEntry = {
      ...base,
      id: 'competing-root-limit',
      limit: {
        kind: 'authority',
        module: 'src/contracts/control-ledger.ts',
        symbol: 'MAX_LIVE_CONTROL_ROOTS',
        value: 999
      }
    };
    const competingRes = validateResourceInventory(
      [...RUNTIME_RESOURCE_INVENTORY, competing],
      AUTHORITATIVE_CONSTANT_VALUES
    );
    expect(competingRes.ok).toBe(false);
    expect(competingRes.errors.some((e) => e.includes('competing value'))).toBe(true);

    const unremediated: InventoryEntry = {
      ...base,
      id: 'unremediated-finding',
      limit: {
        kind: 'unbounded-finding',
        scope: 'some set',
        remediation: '   '
      }
    };
    const unremRes = validateResourceInventory([...RUNTIME_RESOURCE_INVENTORY, unremediated]);
    expect(unremRes.ok).toBe(false);
    expect(unremRes.errors.some((e) => e.includes('without a scoped remediation'))).toBe(true);
  });

  it('enforces US1 scenario 4 on diagnostic collector proposals', () => {
    const validProposal: InventoryEntry = {
      id: 'f03-valid-collector',
      category: 'diagnostic-collector',
      owner: 'src/services/runtime-resource-budgets/resource-collector.ts',
      lifetime: 'per-run',
      units: 'items+bytes',
      limit: { kind: 'f03-owned', boundId: 'resource-collector-window' },
      overflow: 'Overwrite oldest after aggregates.',
      architecture: 'current'
    };
    expect(reviewDiagnosticCollectorProposal(validProposal).ok).toBe(true);

    const unboundedProposal: InventoryEntry = {
      ...validProposal,
      id: 'f03-unbounded-collector',
      limit: { kind: 'protected-state', reason: 'Keep everything forever' }
    };
    expect(reviewDiagnosticCollectorProposal(unboundedProposal).ok).toBe(false);
    expect(validateResourceInventory([...RUNTIME_RESOURCE_INVENTORY, unboundedProposal]).ok).toBe(
      false
    );
  });

  it('reconciles F02 consumer mapping F03 entry with F03 FR-015 constants (T009, FR-012)', () => {
    const f03Entry = ROUND6_FEATURE_CONSUMER_MAPPING.find((e) => e.featureId === 'F03');
    expect(f03Entry).toBeDefined();
    expect(f03Entry!.ownedLimits).toEqual([
      {
        limitName: 'resourceCollectorWindow',
        maxItems: RESOURCE_COLLECTOR_MAX_SAMPLES,
        maxBytes: RESOURCE_COLLECTOR_MAX_BYTES
      },
      {
        limitName: 'pendingAccountingProjectionWork',
        maxItems: PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
        maxBytes: PENDING_ACCOUNTING_PROJECTION_MAX_BYTES
      },
      {
        limitName: 'outstandingAccountingIntents',
        maxItems: OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
        maxBytes: OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES
      }
    ]);
  });

  it('maintains 100% parity between RUNTIME_RESOURCE_INVENTORY ids and docs/operations/runtime-resource-budgets.md', () => {
    const docPath = path.join(REPO_ROOT, 'docs/operations/runtime-resource-budgets.md');
    const docText = fs.readFileSync(docPath, 'utf8');
    for (const entry of RUNTIME_RESOURCE_INVENTORY) {
      expect(
        docText.includes(`\`${entry.id}\``),
        `Inventory id '${entry.id}' is missing from docs/operations/runtime-resource-budgets.md`
      ).toBe(true);
    }
  });
});
