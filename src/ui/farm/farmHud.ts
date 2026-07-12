// ============================================================================
// Farming in-game HUD (opt-in via ?farmui). Renders the pixel-art HUD
// chrome from the cowork preview — score chips, ♪/☰ buttons, a feature-scoring
// banner, the tiles-left box, the hand slot (with gold glow), a prompt sign and
// the teal ✓ — into a transparent RGBA buffer that is blitted over the board.
// Driven entirely by live game state; the hand TILE is drawn by the caller into
// the returned `handSlot` rect. Buttons return hit rects (logical coords).
// ============================================================================

import { type PixBuf, type RGB, drawText, textWidth } from "./pixelfont";
import * as UI from "./uiscene";

const R = UI.RGBP;

export interface HudChip { color: RGB; name: string; score: string; active: boolean; }
export interface HudState {
  chips: HudChip[];
  tilesLeft: string;
  prompt: string;                        // short (<= ~9 chars/line) hint
  confirm: "hidden" | "ok" | "off";      // bottom-right ✓ state
  meeple: boolean;                       // show the "no meeple" (meeple + cross) button
  banner: { text: string; color: RGB } | null; // feature-scored feedback
  muted: boolean;
}
export interface HudHit { id: string; x: number; y: number; w: number; h: number; }
export interface HudRect { x: number; y: number; w: number; h: number; }
export interface HudLayout { hits: HudHit[]; hand: HudRect | null; meeple: HudRect | null; }

function chip(b: PixBuf, x: number, y: number, w: number, dot: RGB, name: string, score: string, active: boolean): void {
  UI.rect(b, x, y, w, 13, [20, 15, 29]);
  for (let i = 0; i < w; i++) { UI.px(b, x + i, y, [68, 52, 86]); UI.px(b, x + i, y + 12, [68, 52, 86]); }
  for (let i = 0; i < 13; i++) { UI.px(b, x, y + i, [68, 52, 86]); UI.px(b, x + w - 1, y + i, [68, 52, 86]); }
  if (active) for (let i = -1; i <= w; i++) { UI.px(b, x + i, y - 1, R.gold); UI.px(b, x + i, y + 13, R.gold); }
  UI.disc(b, x + 6, y + 6, 3, dot);
  drawText(b, name, x + 12, y + 3, R.white, 1, 1, [10, 8, 16]);
  drawText(b, score, x + w - 2 - textWidth(score, 1, 1), y + 3, R.gold, 1, 1, [10, 8, 16]);
}

/** Draw the HUD chrome into `b` (transparent where the board should show). */
export function drawFarmHud(b: PixBuf, t: number, s: HudState): HudLayout {
  const W = b.w, H = b.h;
  const hits: HudHit[] = [];

  // score chips, top-left
  let cy = 6;
  const cw = 84;
  for (const c of s.chips) { chip(b, 4, cy, cw, c.color, c.name, c.score, c.active); cy += 16; }

  // ? / ♪ / ☰ top-right
  UI.button(b, W - 60, 6, 16, 16, "?", { scale: 1 });
  hits.push({ id: "guide", x: W - 60, y: 6, w: 16, h: 16 });
  UI.button(b, W - 40, 6, 16, 16, s.muted ? "x" : "♪", { scale: 1 });
  hits.push({ id: "mute", x: W - 40, y: 6, w: 16, h: 16 });
  UI.button(b, W - 20, 6, 16, 16, "☰", { scale: 1 });
  hits.push({ id: "menu", x: W - 20, y: 6, w: 16, h: 16 });

  // feature-scoring banner (bobs), centred near top
  if (s.banner) {
    const bwid = textWidth(s.banner.text, 2, 1) + 20;
    const by = 60 + Math.round(Math.sin(t * 2) * 2);
    UI.panel(b, Math.round((W - bwid) / 2), by, bwid, 30);
    drawText(b, s.banner.text, Math.round((W - textWidth(s.banner.text, 2, 1)) / 2), by + 10, s.banner.color, 2, 1, [230, 200, 160]);
  }

  // bottom scrim so the dock chrome reads over the board
  for (let y = H - 58; y < H; y++) for (let x = 0; x < W; x++) UI.px(b, x, y, [20, 15, 29], (y - (H - 58)) / 58 * 0.55);

  // tiles-left box, bottom-left
  UI.rect(b, 8, H - 46, 26, 30, [20, 15, 29]);
  for (let i = 0; i < 26; i++) { UI.px(b, 8 + i, H - 46, [68, 52, 86]); UI.px(b, 8 + i, H - 17, [68, 52, 86]); }
  for (let i = 0; i < 30; i++) { UI.px(b, 8, H - 46 + i, [68, 52, 86]); UI.px(b, 33, H - 46 + i, [68, 52, 86]); }
  drawText(b, s.tilesLeft, 8 + Math.round((26 - textWidth(s.tilesLeft, 2, 1)) / 2), H - 42, R.gold, 2, 1, null);
  drawText(b, "LEFT", 8 + Math.round((26 - textWidth("LEFT", 1, 1)) / 2), H - 25, R.white, 1, 1, null);

  // hand slot (frame + pulsing gold glow); the tile is drawn by the caller
  const HT = 44, hx = 44, hy = H - 50;
  UI.rect(b, hx - 2, hy - 2, HT + 4, HT + 4, [36, 26, 46]);
  const glow = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4));
  for (let i = -1; i <= HT; i++) { UI.px(b, hx + i, hy - 2, R.gold, glow); UI.px(b, hx + i, hy + HT + 1, R.gold, glow); UI.px(b, hx - 2, hy + i, R.gold, glow); UI.px(b, hx + HT + 1, hy + i, R.gold, glow); }

  // prompt sign to the right of the hand
  const px0 = hx + HT + 6, pw = W - px0 - 6;
  UI.panel(b, px0, hy + 6, pw, 30);
  const lines = s.prompt.split("\n");
  lines.forEach((ln, i) => drawText(b, ln, px0 + 6, hy + 12 + i * 10, R.ink, 1, 1, null));

  // Single action slot, bottom-right (above the dock scrim). The ✓ confirm and
  // the "no meeple" button share this exact spot and swap in place — never side
  // by side — so the primary action never jumps sideways between phases. The
  // caller draws the follower + cross into the returned `meeple` rect.
  const BW = 48, BH = 44, aby = H - 64 - BH;
  const cbx = W - 6 - BW;
  let meeple: HudRect | null = null;
  if (s.meeple) {
    UI.button(b, cbx, aby, BW, BH, "", { pressed: false });
    hits.push({ id: "nomeeple", x: cbx, y: aby, w: BW, h: BH });
    meeple = { x: cbx, y: aby, w: BW, h: BH };
  } else if (s.confirm !== "hidden") {
    UI.button(b, cbx, aby, BW, BH, "✓", { teal: s.confirm === "ok", pressed: false, scale: 2 });
    if (s.confirm === "off") for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) UI.px(b, cbx + x, aby + y, [20, 15, 29], 0.45);
    hits.push({ id: "confirm", x: cbx, y: aby, w: BW, h: BH });
  }

  return { hits, hand: { x: hx, y: hy, w: HT, h: HT }, meeple };
}
