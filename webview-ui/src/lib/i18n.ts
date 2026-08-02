export const DEFAULT_LOCALE = 'en' as const;

const messages = {
  'settings.rawTranscript.always': 'Always retain',
  'settings.rawTranscript.errorsOnly': 'Errors only',
  'settings.rawTranscript.off': 'Off',
  'metrics.chart.hint': 'Hover or focus a point on the chart for exact values.'
} as const;

export type MessageId = keyof typeof messages;

/** Minimal localization boundary; callers never depend on raw message storage. */
export function t(id: MessageId): string {
  return messages[id];
}
