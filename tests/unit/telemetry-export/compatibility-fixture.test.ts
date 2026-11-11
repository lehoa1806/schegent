// FR-R6-F14 T016 — the compatibility fixture: the synthetic records of source schema 1 encode
// to exactly the request pinned for mapping revision 1 (FR-003, FR-004, FR-018). A change that
// moves this request is a new mapping revision, not an edit of the fixture.
import { describe, expect, it } from 'vitest';
import expectedRequest from '../../fixtures/telemetry-export/mapping-1.expected-request.json';
import sourceRecords from '../../fixtures/telemetry-export/source-schema-1.records.json';
import { createHarness, settle } from '../../fixtures/telemetry-export/exporter-harness';

const RECORDS: readonly unknown[] = sourceRecords;
const SERVICE_VERSION = '0.2.0';

interface WirePoint {
  readonly attributes: readonly { readonly key: string; readonly value: Readonly<Record<string, unknown>> }[];
}
interface WireMetric {
  readonly name: string;
  readonly unit: string;
  readonly sum?: { readonly dataPoints: readonly WirePoint[] };
  readonly histogram?: { readonly dataPoints: readonly WirePoint[] };
}
interface WireRequest {
  readonly resourceMetrics: readonly { readonly scopeMetrics: readonly { readonly metrics: readonly WireMetric[] }[] }[];
}

async function sendFixture(): Promise<{ text: string; accepted: number; refused: number; duplicate: number; coverage: Readonly<Record<string, number>> }> {
  const harness = createHarness({ serviceVersion: SERVICE_VERSION });
  harness.authorize();
  const offered = harness.exporter.offer(RECORDS);
  harness.exporter.flush();
  await settle();
  expect(harness.transport.requests).toHaveLength(1);
  const text = harness.transport.requests.at(0)?.text ?? '';
  return { text, ...offered, coverage: harness.exporter.health().coverage };
}

function metricsOf(request: WireRequest): readonly WireMetric[] {
  return request.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
}

function attributeValues(metrics: readonly WireMetric[], key: string): string[] {
  const values = metrics.flatMap((metric) =>
    [...(metric.sum?.dataPoints ?? []), ...(metric.histogram?.dataPoints ?? [])].flatMap((point) =>
      point.attributes.filter((attribute) => attribute.key === key).map((attribute) => String(attribute.value.stringValue))
    )
  );
  return [...new Set(values)].sort();
}

describe('telemetry export compatibility fixture: source schema 1 to mapping revision 1', () => {
  it('accepts every record of the fixture', async () => {
    const sent = await sendFixture();
    expect({ accepted: sent.accepted, duplicate: sent.duplicate, refused: sent.refused }).toEqual({
      accepted: RECORDS.length,
      duplicate: 0,
      refused: 0
    });
  });

  it('encodes the records to exactly the expected request, key order included', async () => {
    const sent = await sendFixture();
    expect(JSON.parse(sent.text)).toEqual(expectedRequest);
    expect(sent.text).toBe(JSON.stringify(expectedRequest));
  });

  it('counts each measure, operation and correction of the fixture once', async () => {
    const sent = await sendFixture();
    expect(sent.coverage).toEqual({
      exported: 10,
      missing: 2,
      unmapped: 2,
      'out-of-range': 0,
      correction: 2,
      'correction-unquantified': 1,
      'excluded-dimension': 0,
      overflow: 0
    });
  });

  it('covers every instrument, two currencies, an estimate and a partial value', () => {
    const metrics = metricsOf(expectedRequest as unknown as WireRequest);
    expect([...new Set(metrics.map((metric) => metric.name))].sort()).toEqual([
      'gen_ai.client.operation.duration',
      'gen_ai.client.token.usage',
      'schegent.export.coverage',
      'schegent.usage.cache_tokens',
      'schegent.usage.cost',
      'schegent.usage.cost_adjustment',
      'schegent.usage.token_adjustment'
    ]);
    expect(metrics.filter((metric) => metric.name === 'schegent.usage.cost').map((metric) => metric.unit).sort()).toEqual(['EUR', 'USD']);
    expect(attributeValues(metrics, 'schegent.usage.provenance')).toEqual(['derived', 'estimated', 'provider-reported']);
    expect(attributeValues(metrics, 'schegent.usage.completeness')).toEqual(['known', 'partial']);
    expect(attributeValues(metrics, 'schegent.export.outcome')).toEqual([
      'correction',
      'correction-unquantified',
      'exported',
      'missing',
      'unmapped'
    ]);
  });
});
