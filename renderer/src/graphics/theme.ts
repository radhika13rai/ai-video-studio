import { DEFAULT_GRAPHICS_THEME, type GraphicsTheme } from "@avs/schemas";

/**
 * Design tokens for graphics scenes (ADR 048). Layouts are drawn on a 1080 × 1920 design canvas
 * and scaled to the output size, so every size here is in design pixels.
 */

export const DESIGN_W = 1080;
export const DESIGN_H = 1920;

/** Instagram's safe area: keep text out of the top 220 px and the bottom 380 px. */
export const SAFE = { top: 220, bottom: DESIGN_H - 380, left: 60, right: DESIGN_W - 60 } as const;

export interface Tokens {
  background: string;
  dot: string;
  accent: string;
  accentDark: string;
  accentLight: string;
  blue: string;
  card: string;
  ink: string;
  muted: string;
  red: string;
  green: string;
  radius: number;
  shadow: { color: string; blur: number; y: number };
}

/** Mixes a #RRGGBB colour towards white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function tokens(theme: GraphicsTheme = DEFAULT_GRAPHICS_THEME): Tokens {
  const p = theme.palette;
  return {
    background: p.background,
    dot: "rgba(17,24,39,0.11)",
    accent: p.accent,
    accentDark: p.accent_dark,
    accentLight: shade(p.accent, 0.35),
    blue: p.highlight,
    card: "#FFFFFF",
    ink: "#111827",
    muted: "#6B7280",
    red: "#EF4444",
    green: "#22C55E",
    radius: 28,
    shadow: { color: "rgba(15,23,42,0.13)", blur: 34, y: 14 },
  };
}

export const BODY_FONT = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
export const DISPLAY_FAMILY = "Lilita One";

let displayReady = false;
/** Marks the display font as loaded (set by loadDisplayFont). */
export function setDisplayFontReady(ready: boolean): void {
  displayReady = ready;
}
export function isDisplayFontReady(): boolean {
  return displayReady;
}
/** The chunky headline font, or bold Inter when Lilita One couldn't load. */
export function displayFont(size: number): string {
  return displayReady
    ? `400 ${Math.round(size)}px "${DISPLAY_FAMILY}", ${BODY_FONT}`
    : `900 ${Math.round(size)}px ${BODY_FONT}`;
}
export function bodyFont(size: number, weight = 700): string {
  return `${weight} ${Math.round(size)}px ${BODY_FONT}`;
}
