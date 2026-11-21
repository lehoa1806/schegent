import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = readonly [number, number, number];

function mix(foreground: Rgb, background: Rgb, foregroundWeight: number): Rgb {
  return foreground.map((channel, index) =>
    Math.round(channel * foregroundWeight + background[index]! * (1 - foregroundWeight))
  ) as unknown as Rgb;
}

function luminance([red, green, blue]: Rgb): number {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(a: Rgb, b: Rgb): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('semantic error text contrast', () => {
  it('keeps the local-preview fallback above WCAG AA on plain and tinted surfaces', () => {
    const css = readFileSync(join(__dirname, '../../lib/theme.css'), 'utf8');
    expect(css).toMatch(/--schegent-error-text:[\s\S]*?55%[\s\S]*?var\(--schegent-fg\)/);

    const errorRed: Rgb = [241, 76, 76];
    const foreground: Rgb = [204, 204, 204];
    const surface: Rgb = [37, 37, 38];
    const errorText = mix(errorRed, foreground, 0.55);
    const tintedSurface = mix(errorRed, surface, 0.08);

    expect(contrast(errorText, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(errorText, tintedSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps secondary and danger button hover fallbacks at WCAG AA contrast', () => {
    const css = readFileSync(join(__dirname, '../../lib/theme.css'), 'utf8');
    expect(css).toMatch(
      /--schegent-button-secondary-hover:[\s\S]*?--vscode-button-secondaryHoverBackground[\s\S]*?10%/
    );
    expect(css).toMatch(/--schegent-error-bg:[\s\S]*?9%/);

    const fg: Rgb = [204, 204, 204];
    const secondaryBg: Rgb = [58, 61, 65];
    const secondaryFg: Rgb = [240, 240, 240];
    const secondaryHoverBg = mix(fg, secondaryBg, 0.1);
    expect(contrast(secondaryFg, secondaryHoverBg)).toBeGreaterThanOrEqual(4.5);

    const errorRed: Rgb = [241, 76, 76];
    const surface: Rgb = [37, 37, 38];
    const bg: Rgb = [30, 30, 30];
    const errorText = mix(errorRed, fg, 0.55);
    expect(contrast(errorText, mix(errorRed, surface, 0.09))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(errorText, mix(errorRed, bg, 0.09))).toBeGreaterThanOrEqual(4.5);
  });
});
