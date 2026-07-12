// ============================================================================
// Farming pixel scene + UI widgets (ported from the cowork UI preview).
// Everything draws into a plain RGBA buffer {w,h,data}; animatable via `t`.
// Wooden sign panels, chunky pixel buttons, and a dithered dusk background with
// a setting sun, twinkling stars, drifting clouds, parallax hills, swaying wheat
// and fireflies — the field greens match the pixel tiles so menu → board flows.
// ============================================================================

import { type PixBuf, type RGB, drawText, textWidth, FH } from "./pixelfont";

const C: Record<string, string> = {
  skyTop: "#241a38", skyUp: "#3f2b57", skyMid: "#7a3f5e", skyLow: "#c46a5a", horizon: "#f0a35e",
  sunCore: "#ffe9a8", sun: "#ffb85c", sunHalo: "#ff9a55",
  star: "#f4ecc8", star2: "#a9c6e0",
  cloudHi: "#f6cda2", cloud: "#d99a8e", cloudDk: "#b3728a",
  hillBack: "#6d5a88", hillBackHi: "#836ea0",
  hillMid: "#4a6a5c", hillMidHi: "#5c8068",
  hillFront: "#33513a", hillFrontHi: "#3f6444",
  grassHi: "#8fca4a", grass: "#6cae3c", grassMid: "#4c8c32", grassDark: "#356b2b", grassDeep: "#274d24",
  wheatHi: "#f0d873", wheat: "#cda44a", wheatStalk: "#b98a34", wheatSeed: "#e6c24a",
  fenceHi: "#c0894c", fence: "#8a5a30", fenceDk: "#5a3a1e",
  firefly: "#f6ee9c", fireflyDim: "#c9c05a",
  panelFill: "#f2e2b6", panelFill2: "#e4cd93", panelWood: "#7a512e", panelWoodHi: "#a9713f", panelWoodDk: "#4a2f18",
  outline: "#241a2e", ink: "#3a2a1a",
  gold: "#f2c94e", goldDk: "#b8922f", teal: "#48b4d2", tealDk: "#1c6d86", red: "#cd5330",
  btnFace: "#c98b53", btnFaceHi: "#e0a768", btnFaceDk: "#9a6335",
  white: "#f6f0dc",
};
export const RGBP: Record<string, RGB> = {};
for (const k in C) {
  const c = C[k].replace(/[^0-9a-f]/gi, "").slice(0, 6);
  RGBP[k] = [parseInt(c.slice(0, 2), 16) || 0, parseInt(c.slice(2, 4), 16) || 0, parseInt(c.slice(4, 6), 16) || 0];
}
const R = RGBP;

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const dth = (x: number, y: number): number => (BAYER[y & 3][x & 3] + 0.5) / 16;
function hash(x: number, y: number, s: number): number { let h = (x * 374761393 + y * 668265263 + s * 2246822519) >>> 0; h = (h ^ (h >>> 13)) >>> 0; h = (h * 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }

export function px(b: PixBuf, x: number, y: number, rgb: RGB, a?: number): void {
  x |= 0; y |= 0; if (x < 0 || y < 0 || x >= b.w || y >= b.h) return;
  const i = (y * b.w + x) * 4, d = b.data;
  if (a === undefined || a >= 1) { d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255; }
  else { d[i] = d[i] * (1 - a) + rgb[0] * a; d[i + 1] = d[i + 1] * (1 - a) + rgb[1] * a; d[i + 2] = d[i + 2] * (1 - a) + rgb[2] * a; d[i + 3] = 255; }
}
export function rect(b: PixBuf, x: number, y: number, w: number, h: number, rgb: RGB): void { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(b, xx, yy, rgb); }
export function hline(b: PixBuf, x0: number, x1: number, y: number, rgb: RGB): void { for (let x = x0; x <= x1; x++) px(b, x, y, rgb); }
export function disc(b: PixBuf, cx: number, cy: number, r: number, rgb: RGB): void { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) px(b, cx + x, cy + y, rgb); }
const lerpCol = (a: RGB, bb: RGB, t: number): RGB => [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t];

function drawSky(b: PixBuf): void {
  const stops: [number, RGB][] = [[0.0, R.skyTop], [0.28, R.skyUp], [0.5, R.skyMid], [0.72, R.skyLow], [0.86, R.horizon]];
  const horizonY = Math.round(b.h * 0.62);
  for (let y = 0; y < horizonY; y++) {
    const f = y / horizonY;
    let c0 = stops[0][1], c1 = stops[stops.length - 1][1], seg0 = 0, seg1 = 1;
    for (let i = 0; i < stops.length - 1; i++) if (f >= stops[i][0] && f <= stops[i + 1][0]) { c0 = stops[i][1]; c1 = stops[i + 1][1]; seg0 = stops[i][0]; seg1 = stops[i + 1][0]; }
    const lt = (f - seg0) / Math.max(0.0001, seg1 - seg0);
    for (let x = 0; x < b.w; x++) {
      const base = lerpCol(c0, c1, lt), alt = lerpCol(c0, c1, Math.min(1, lt + 0.18));
      px(b, x, y, dth(x, y) < 0.5 ? base : alt);
    }
  }
}
function drawStars(b: PixBuf, t: number): void {
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(hash(i, 1, 7) * b.w), y = Math.floor(hash(i, 2, 7) * b.h * 0.42);
    const tw = 0.5 + 0.5 * Math.sin(t * 2 + i * 1.3);
    if (tw > 0.55) px(b, x, y, i % 4 === 0 ? R.star2 : R.star, 0.5 + tw * 0.5);
  }
}
function drawSun(b: PixBuf): void {
  const cx = Math.round(b.w * 0.5), cy = Math.round(b.h * 0.52), r = Math.round(b.w * 0.16);
  for (let rr = r + 4; rr > r; rr--) disc(b, cx, cy, rr, R.sunHalo);
  disc(b, cx, cy, r, R.sun);
  disc(b, cx - Math.round(r * 0.28), cy - Math.round(r * 0.28), Math.round(r * 0.55), R.sunCore);
}
function cloud(b: PixBuf, x: number, y: number, s: number): void {
  disc(b, x, y, s, R.cloud); disc(b, x + s, y + 1, Math.round(s * 0.8), R.cloud); disc(b, x - s, y + 1, Math.round(s * 0.7), R.cloud);
  disc(b, x, y - 1, Math.round(s * 0.8), R.cloudHi); disc(b, x + s - 1, y, Math.round(s * 0.55), R.cloudHi);
  for (let xx = x - s - 2; xx <= x + s + 2; xx++) px(b, xx, y + s, R.cloudDk, 0.5);
}
function drawClouds(b: PixBuf, t: number): void {
  const puffs: [number, number, number][] = [[0.2, 0.16, 7], [0.75, 0.12, 6], [0.55, 0.26, 8], [0.12, 0.32, 5], [0.86, 0.30, 6]];
  for (let i = 0; i < puffs.length; i++) {
    const bx = (puffs[i][0] * b.w + t * (6 + i * 2)) % (b.w + 40) - 20;
    cloud(b, Math.round(bx), Math.round(puffs[i][1] * b.h), puffs[i][2]);
  }
}
function hillLayer(b: PixBuf, baseY: number, amp: number, wl: number, phase: number, colTop: RGB, colFill: RGB): void {
  for (let x = 0; x < b.w; x++) {
    const y = Math.round(baseY + Math.sin((x / wl) + phase) * amp + Math.sin((x / (wl * 0.5)) + phase * 2) * amp * 0.3);
    px(b, x, y, colTop); px(b, x, y - 1, colTop);
    for (let yy = y + 1; yy < b.h; yy++) px(b, x, yy, colFill);
  }
}
function drawField(b: PixBuf, t: number): void {
  const top = Math.round(b.h * 0.62);
  for (let y = top; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const f = (y - top) / (b.h - top), n = hash(x, y, 5), d = dth(x, y);
      const v = f * 0.6 + (0.5 - d) * 0.25 + (n - 0.5) * 0.16;
      let col: RGB;
      if (v < 0.22) col = R.grassHi; else if (v < 0.46) col = R.grass; else if (v < 0.72) col = R.grassMid; else col = R.grassDark;
      px(b, x, y, col);
    }
  const rowY = [top + 6, top + 16, top + 28, top + 42];
  for (let r = 0; r < rowY.length; r++) {
    const y0 = rowY[r]; if (y0 >= b.h - 2) continue;
    const spacing = 6 - r;
    for (let x = 3 + (r % 2) * 2; x < b.w - 2; x += spacing) {
      const sway = Math.round(Math.sin(t * 1.6 + x * 0.4 + r) * (1 + r * 0.4)), hgt = 5 + r;
      for (let k = 0; k < hgt; k++) px(b, x + Math.round((k / hgt) * sway), y0 - k, R.wheatStalk);
      const tx = x + sway, ty = y0 - hgt;
      px(b, tx, ty, R.wheatHi); px(b, tx, ty - 1, R.wheatSeed); px(b, tx - 1, ty, R.wheatSeed); px(b, tx + 1, ty, R.wheatSeed);
    }
  }
  const fy = top - 1;
  hline(b, 0, b.w - 1, fy, R.fenceDk); hline(b, 0, b.w - 1, fy - 3, R.fence);
  for (let x = 4; x < b.w; x += 14) { for (let k = 0; k < 6; k++) px(b, x, fy - k, R.fence); px(b, x, fy - 6, R.fenceHi); }
}
function drawFireflies(b: PixBuf, t: number): void {
  for (let i = 0; i < 14; i++) {
    const bx = (hash(i, 3, 9) * b.w + Math.sin(t * 0.7 + i) * 6);
    const by = b.h * 0.66 + hash(i, 4, 9) * b.h * 0.3 + Math.cos(t * 0.9 + i * 2) * 5;
    const glow = 0.5 + 0.5 * Math.sin(t * 3 + i * 2);
    if (glow > 0.3) { px(b, Math.round(bx), Math.round(by), R.firefly, glow); if (glow > 0.75) { px(b, Math.round(bx) + 1, Math.round(by), R.fireflyDim, 0.5); px(b, Math.round(bx), Math.round(by) + 1, R.fireflyDim, 0.5); } }
  }
}
export function drawBackground(b: PixBuf, t: number): void {
  drawSky(b); drawStars(b, t); drawSun(b); drawClouds(b, t);
  hillLayer(b, Math.round(b.h * 0.5), b.h * 0.05, b.w * 0.35, 0.4, R.hillBackHi, R.hillBack);
  hillLayer(b, Math.round(b.h * 0.56), b.h * 0.045, b.w * 0.28, 2.1, R.hillMidHi, R.hillMid);
  hillLayer(b, Math.round(b.h * 0.61), b.h * 0.04, b.w * 0.22, 4.0, R.hillFrontHi, R.hillFront);
  drawField(b, t); drawFireflies(b, t);
}

/** Wooden sign / parchment panel. */
export function panel(b: PixBuf, x: number, y: number, w: number, h: number): void {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (xx >= w - 3 || yy >= h - 3) px(b, x + xx + 2, y + yy + 3, R.outline, 0.28);
  rect(b, x, y, w, h, R.outline);
  rect(b, x + 1, y + 1, w - 2, h - 2, R.panelWood);
  hline(b, x + 1, x + w - 2, y + 1, R.panelWoodHi);
  for (let yy = y + 1; yy < y + h - 1; yy++) px(b, x + 1, yy, R.panelWoodHi);
  hline(b, x + 1, x + w - 2, y + h - 2, R.panelWoodDk);
  for (let yy = y + 1; yy < y + h - 1; yy++) px(b, x + w - 2, yy, R.panelWoodDk);
  const p = 4;
  for (let yy = y + p; yy < y + h - p; yy++) for (let xx = x + p; xx < x + w - p; xx++) px(b, xx, yy, hash(xx, yy, 2) > 0.92 ? R.panelFill2 : R.panelFill);
  rect(b, x + p - 1, y + p - 1, w - 2 * p + 2, 1, R.panelWoodDk);
  rect(b, x + p - 1, y + h - p, w - 2 * p + 2, 1, R.panelWoodHi);
  for (const [nx, ny] of [[x + 3, y + 3], [x + w - 4, y + 3], [x + 3, y + h - 4], [x + w - 4, y + h - 4]]) { px(b, nx, ny, R.panelWoodDk); px(b, nx, ny - 1, R.fenceHi); }
}

export interface BtnOpts { gold?: boolean; teal?: boolean; red?: boolean; sel?: boolean; pressed?: boolean; scale?: number; tracking?: number; }
/** Chunky pixel button with press feedback; gold/teal/red/selected variants. */
export function button(b: PixBuf, x: number, y: number, w: number, h: number, label: string, opts: BtnOpts = {}): void {
  const face = opts.gold ? R.gold : opts.teal ? R.teal : opts.red ? R.red : R.btnFace;
  const faceHi = opts.gold ? [255, 225, 120] : opts.teal ? [111, 208, 230] : opts.red ? [230, 120, 90] : R.btnFaceHi;
  const faceDk = opts.gold ? R.goldDk : opts.teal ? R.tealDk : opts.red ? [150, 52, 30] : R.btnFaceDk;
  const press = opts.pressed ? 2 : 0;
  if (!opts.pressed) for (let xx = 0; xx < w; xx++) { px(b, x + xx, y + h, R.outline, 0.4); px(b, x + xx, y + h + 1, R.outline, 0.25); }
  const yy = y + press;
  rect(b, x, yy, w, h, R.outline);
  rect(b, x + 1, yy + 1, w - 2, h - 2, face);
  hline(b, x + 1, x + w - 2, yy + 1, faceHi);
  for (let r = yy + 1; r < yy + h - 1; r++) px(b, x + 1, r, faceHi);
  hline(b, x + 1, x + w - 2, yy + h - 2, faceDk);
  for (let r = yy + 1; r < yy + h - 1; r++) px(b, x + w - 2, r, faceDk);
  if (opts.sel) { rect(b, x - 1, yy - 1, w + 2, 1, R.teal); rect(b, x - 1, yy + h, w + 2, 1, R.teal); for (let r = yy - 1; r <= yy + h; r++) { px(b, x - 1, r, R.teal); px(b, x + w, r, R.teal); } }
  if (label) {
    const scale = opts.scale || 1, tr = opts.tracking ?? 1, tw = textWidth(label, scale, tr);
    const tx = x + Math.round((w - tw) / 2), ty = yy + Math.round((h - FH * scale) / 2);
    const ink = opts.gold || opts.teal ? R.outline : R.white;
    const sh = opts.gold || opts.teal ? null : R.btnFaceDk;
    drawText(b, label, tx, ty, ink, scale, tr, sh);
  }
}
