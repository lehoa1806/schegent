// The error an audit payload projection throws, in its own module so a projector in a sibling file can
// throw it without importing `audit-payload.ts`, which imports that projector (FR-R4-F04: the closed
// `evidence-exported` projection is the first sibling). `audit-payload.ts` re-exports it, so every
// existing import of `AuditPayloadValidationError` from there is unchanged and names the same class.

export class AuditPayloadValidationError extends Error {
  constructor(public readonly reasonCode: string) {
    super(`audit payload rejected: ${reasonCode}`);
    this.name = 'AuditPayloadValidationError';
  }
}
