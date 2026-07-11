// ============================================================================
// T3dassonne — CELESTE-STYLE PIXEL tile renderer.
// Every tile is drawn procedurally into a 48x48 buffer and blitted unsmoothed
// (crisp pixels) with a limited warm/cool palette, hard dark-plum outlines and
// ordered dithering. Public API (drawTile / computeMeepleSpot / clearTileCache /
// prewarmTile / TILE_BUFFER_RES / DrawTileOpts) and the segment + rotation
// contract are unchanged, so engine / ai / meeples / board keep working as-is.
//
// Rotation model:  side k -> (k+rot)%4 ;  halfEdge h -> (h+2rot)%8
// Segment.edges are stored UNROTATED; rotated here for drawing.
// ============================================================================

import type { Rotation, Segment, TileDef } from "../core/types";

// ---- Internal pixel palette (tile art only; does NOT touch meeple colours) --
const PX = {
  grassHi: "#9fd45a", grass: "#6cae3c", grassMid: "#4c8c32", grassDark: "#356b2b",
  grassDeep: "#274d24", bush: "#3f7a2e", bushDark: "#2c5a24",
  roadHi: "#ecdcab", road: "#cdb079", roadMid: "#a5854f", roadDark: "#6f5232",
  stoneHi: "#d3dbe6", stone: "#9fb0c2", stoneMid: "#6f8298", stoneDark: "#495a72",
  cityGround: "#e6d2a4", cityGroundDk: "#cdb680",
  roofHi: "#eb8250", roof: "#cd5330", roofDark: "#94331d",
  wallHi: "#f2ddac", wall: "#d8b779", wallDark: "#a9824f", window: "#33263f", windowGlow: "#f4cf6b",
  waterHi: "#a5ebe2", water: "#48b4d2", waterMid: "#2c82b2", waterDark: "#1b5a86", waterEdge: "#123f63",
  bank: "#5c8a54", bankDark: "#3f6b3d",
  chapelWall: "#ecd6a2", chapelWallDk: "#c19f68", chapelRoof: "#c74f33", chapelRoofDk: "#8f3320", cross: "#f4e6b4",
  pennant: "#33509c", pennantHi: "#5878c4", pennantGold: "#f2c94e",
  woodHi: "#c0894c", wood: "#8a5a30", woodDark: "#5a3a1e",
  flowerWhite: "#f4efd8", flowerYellow: "#f4d24c", flowerPink: "#e58bb0", flowerRed: "#d85450",
  outline: "#2b2138", outlineSoft: "#3d3350", frame: "#211a2e", highlightEdge: "#ffe066", highlight: "#fff2a8",
} as const;

type RGB = [number, number, number];
function hexToRgb(hex: string): RGB {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
const RGB: Record<string, RGB> = {};
for (const k in PX) RGB[k] = hexToRgb((PX as Record<string, string>)[k]);

// Which drawn colours count as "field" (grass, bushes, flowers) — used to trace
// the farm outline so its extent and cross-tile continuity read clearly.
const GRASS_KEYS = ["grassHi", "grass", "grassMid", "grassDark", "grassDeep", "bush", "bushDark", "flowerWhite", "flowerYellow", "flowerPink", "flowerRed"];
const GRASS_SET = new Set<string>(GRASS_KEYS.map((k) => RGB[k].join(",")));

// ---- buffer / geometry ---------------------------------------------------
const BUF = 48;
const CX = BUF / 2;
const CY = BUF / 2;

interface Buf { data: Uint8ClampedArray; }
function newBuf(): Buf { return { data: new Uint8ClampedArray(BUF * BUF * 4) }; }
function setPx(buf: Buf, x: number, y: number, rgb: RGB, a?: number): void {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= BUF || y >= BUF) return;
  const i = (y * BUF + x) * 4;
  const d = buf.data;
  if (a === undefined || a >= 1) { d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255; }
  else {
    d[i] = d[i] * (1 - a) + rgb[0] * a;
    d[i + 1] = d[i + 1] * (1 - a) + rgb[1] * a;
    d[i + 2] = d[i + 2] * (1 - a) + rgb[2] * a;
    d[i + 3] = 255;
  }
}
function fillRect(buf: Buf, x: number, y: number, w: number, h: number, rgb: RGB): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(buf, xx, yy, rgb);
}

function hash2(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const dither = (x: number, y: number): number => (BAYER[y & 3][x & 3] + 0.5) / 16;

// ---- rotation helpers ----------------------------------------------------
const rotSide = (k: number, rot: number): number => (k + rot) % 4;
const rotHalf = (h: number, rot: number): number => (h + 2 * rot) % 8;
function rotatedEdges(seg: Segment, rot: number): number[] {
  if (seg.kind === "field") return seg.edges.map((h) => rotHalf(h, rot));
  if (seg.kind === "cloister") return [];
  return seg.edges.map((k) => rotSide(k, rot));
}
const SIDE_MIDPT: Record<number, [number, number]> = { 0: [0.5, 0], 1: [1, 0.5], 2: [0.5, 1], 3: [0, 0.5] };
const endpoint = (s: number): [number, number] => { const p = SIDE_MIDPT[s]; return [p[0] * BUF, p[1] * BUF]; };
const isOpposite = (a: number, b: number): boolean => (a + 2) % 4 === b;
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}
type Bone = [number, number, number, number];
function buildBones(sides: number[]): Bone[] {
  const bones: Bone[] = [];
  if (sides.length === 2 && isOpposite(sides[0], sides[1])) {
    const a = endpoint(sides[0]), b = endpoint(sides[1]);
    bones.push([a[0], a[1], b[0], b[1]]);
  } else if (sides.length === 2) {
    const a = endpoint(sides[0]), b = endpoint(sides[1]);
    const STEPS = 14; let px = a[0], py = a[1];
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS, mt = 1 - t;
      const qx = mt * mt * a[0] + 2 * mt * t * CX + t * t * b[0];
      const qy = mt * mt * a[1] + 2 * mt * t * CY + t * t * b[1];
      bones.push([px, py, qx, qy]); px = qx; py = qy;
    }
  } else {
    for (const s of sides) { const e = endpoint(s); bones.push([e[0], e[1], CX, CY]); }
  }
  return bones;
}

// ---------------------------------------------------------------------------
// GRASS / FIELDS
// ---------------------------------------------------------------------------
function drawGrass(buf: Buf, salt: number): void {
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const t = y / BUF, n = hash2(x, y, salt + 7), d = dither(x, y);
      const v = t * 0.85 + (0.5 - d) * 0.22 + (n - 0.5) * 0.14;
      let col: RGB;
      if (v < 0.2) col = RGB.grassHi; else if (v < 0.46) col = RGB.grass;
      else if (v < 0.72) col = RGB.grassMid; else col = RGB.grassDark;
      setPx(buf, x, y, col);
    }
  for (let i = 0; i < 10; i++) {
    const bx = 4 + Math.floor(hash2(i, 11, salt + 3) * (BUF - 8));
    const by = 4 + Math.floor(hash2(i, 12, salt + 3) * (BUF - 8));
    if (hash2(i, 13, salt + 3) > 0.55) {
      setPx(buf, bx, by, RGB.bush); setPx(buf, bx + 1, by, RGB.bush);
      setPx(buf, bx, by + 1, RGB.bushDark); setPx(buf, bx + 1, by + 1, RGB.bush);
      setPx(buf, bx - 1, by, RGB.bushDark);
    }
  }
  const fcol = [RGB.flowerWhite, RGB.flowerYellow, RGB.flowerPink, RGB.flowerRed];
  for (let i = 0; i < 8; i++) {
    const fx = 3 + Math.floor(hash2(i, 21, salt + 5) * (BUF - 6));
    const fy = 3 + Math.floor(hash2(i, 22, salt + 5) * (BUF - 6));
    if (hash2(i, 23, salt + 5) > 0.62) setPx(buf, fx, fy, fcol[i & 3]);
  }
}

// ---------------------------------------------------------------------------
// ROADS
// ---------------------------------------------------------------------------
const ROAD_HW = 3;
function roadDistField(sides: number[]): Float32Array {
  const bones = buildBones(sides);
  const dist = new Float32Array(BUF * BUF).fill(Infinity);
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const bn of bones) { const dd = distToSeg(x + 0.5, y + 0.5, bn[0], bn[1], bn[2], bn[3]); if (dd < d) d = dd; }
      if (sides.length !== 2) { const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY); if (dc < d) d = Math.max(0, dc - ROAD_HW * 0.3); }
      dist[y * BUF + x] = d;
    }
  return dist;
}
function drawRoad(buf: Buf, sides: number[], salt: number): void {
  const hw = ROAD_HW, dist = roadDistField(sides);
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const d = dist[y * BUF + x]; if (d > hw + 1) continue;
      const t = d / hw; let col: RGB;
      if (t > 1) col = RGB.roadDark; else if (t > 0.62) col = RGB.roadMid; else col = RGB.road;
      const n = hash2(x, y, salt + 5);
      if (t < 0.5 && n > 0.86) col = RGB.roadHi; else if (t < 0.85 && n < 0.1) col = RGB.roadMid;
      setPx(buf, x, y, col);
    }
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const d = dist[y * BUF + x];
      if (d > hw + 0.2 && d <= hw + 1.2) { const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1; if (!onEdge) setPx(buf, x, y, RGB.roadDark); }
    }
  const bones = buildBones(sides); let acc = 0;
  for (const bn of bones) {
    const len = Math.hypot(bn[2] - bn[0], bn[3] - bn[1]), steps = Math.max(1, Math.round(len));
    for (let i = 0; i <= steps; i++) {
      acc++; if (acc % 4 < 2) continue;
      const f = i / steps, x = Math.round(bn[0] + (bn[2] - bn[0]) * f), y = Math.round(bn[1] + (bn[3] - bn[1]) * f);
      if (dist[y * BUF + x] < hw * 0.55) setPx(buf, x, y, RGB.roadHi);
    }
  }
  if (sides.length >= 3) {
    const pr = Math.round(hw * 1.6);
    for (let y = CY - pr - 1; y <= CY + pr + 1; y++)
      for (let x = CX - pr - 1; x <= CX + pr + 1; x++) {
        const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
        if (dc <= pr) setPx(buf, x, y, hash2(x, y, salt + 9) > 0.7 ? RGB.roadHi : RGB.road);
        else if (dc <= pr + 1) setPx(buf, x, y, RGB.roadDark);
      }
  }
}

// ---------------------------------------------------------------------------
// RIVER / WATER
// ---------------------------------------------------------------------------
const RIVER_HW = 6;
interface WaterField { mask: Uint8Array; dist: Float32Array; }
function waterMaskAndDist(sides: number[]): WaterField {
  const hw = RIVER_HW; const bones: Bone[] = []; let lake: { x: number; y: number; r: number } | null = null;
  if (sides.length === 1) {
    const e = endpoint(sides[0]); const dirX = CX - e[0], dirY = CY - e[1], len = Math.hypot(dirX, dirY) || 1;
    const lx = CX + (dirX / len) * hw, ly = CY + (dirY / len) * hw;
    bones.push([e[0], e[1], lx, ly]); lake = { x: lx, y: ly, r: Math.round(hw * 1.4) };
  } else for (const bn of buildBones(sides)) bones.push(bn);
  const mask = new Uint8Array(BUF * BUF), dist = new Float32Array(BUF * BUF);
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const bn of bones) { const dd = distToSeg(x + 0.5, y + 0.5, bn[0], bn[1], bn[2], bn[3]); if (dd < d) d = dd; }
      if (lake) { const dl = Math.hypot(x + 0.5 - lake.x, y + 0.5 - lake.y) - lake.r; if (dl < d) d = dl < 0 ? 0 : dl; }
      if (d <= hw) { mask[y * BUF + x] = 1; dist[y * BUF + x] = d; }
    }
  return { mask, dist };
}
function drawRiver(buf: Buf, sides: number[], salt: number): void {
  const hw = RIVER_HW; const wf = waterMaskAndDist(sides); const mask = wf.mask, dist = wf.dist;
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      if (!mask[y * BUF + x]) continue;
      const t = dist[y * BUF + x] / hw, n = hash2(x, y, salt + 61), ripple = hash2(x + (y >> 1), y, salt + 71);
      let col: RGB;
      if (t < 0.32) col = ripple > 0.82 || n > 0.9 ? RGB.waterHi : RGB.water;
      else if (t < 0.7) col = n < 0.14 ? RGB.waterDark : RGB.waterMid;
      else col = n < 0.3 ? RGB.waterEdge : RGB.waterDark;
      setPx(buf, x, y, col);
    }
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      if (!mask[y * BUF + x]) continue;
      const border = (x > 0 && !mask[y * BUF + x - 1]) || (x < BUF - 1 && !mask[y * BUF + x + 1]) ||
        (y > 0 && !mask[(y - 1) * BUF + x]) || (y < BUF - 1 && !mask[(y + 1) * BUF + x]);
      const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1;
      if (border && !onEdge) setPx(buf, x, y, RGB.waterEdge);
    }
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      if (mask[y * BUF + x]) continue;
      const touch = (x > 0 && mask[y * BUF + x - 1]) || (x < BUF - 1 && mask[y * BUF + x + 1]) ||
        (y > 0 && mask[(y - 1) * BUF + x]) || (y < BUF - 1 && mask[(y + 1) * BUF + x]);
      const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1;
      if (touch && !onEdge) setPx(buf, x, y, hash2(x, y, salt + 3) > 0.5 ? RGB.bank : RGB.bankDark);
    }
}
function drawBridge(buf: Buf, roadSides: number[], riverSides: number[]): void {
  if (riverSides.length < 2) return;
  const bones = buildBones(riverSides);
  const overWater = (x: number, y: number): boolean => { let d = Infinity; for (const bn of bones) d = Math.min(d, distToSeg(x, y, bn[0], bn[1], bn[2], bn[3])); return d <= RIVER_HW + 1; };
  const hw = ROAD_HW + 1, span = Math.round(BUF * 0.34);
  for (const s of roadSides) {
    const horiz = s === 1 || s === 3;
    for (let d = 0; d <= span; d++) {
      const x = s === 1 ? CX + d : s === 3 ? CX - d : CX;
      const y = s === 0 ? CY - d : s === 2 ? CY + d : CY;
      if (!overWater(x, y)) continue;
      if (horiz) fillRect(buf, Math.round(x), CY - hw, 1, hw * 2, d % 3 === 0 ? RGB.woodDark : RGB.wood);
      else fillRect(buf, CX - hw, Math.round(y), hw * 2, 1, d % 3 === 0 ? RGB.woodDark : RGB.wood);
    }
    if (horiz) for (let d = 0; d <= span; d++) { const x = s === 1 ? CX + d : CX - d; if (!overWater(x, CY)) continue; setPx(buf, Math.round(x), CY - hw - 1, RGB.woodHi); setPx(buf, Math.round(x), CY + hw, RGB.woodDark); }
    else for (let d = 0; d <= span; d++) { const y = s === 2 ? CY + d : CY - d; if (!overWater(CX, y)) continue; setPx(buf, CX - hw - 1, Math.round(y), RGB.woodHi); setPx(buf, CX + hw, Math.round(y), RGB.woodDark); }
  }
}

// ---------------------------------------------------------------------------
// CITY
// ---------------------------------------------------------------------------
function sharedCorner(a: number, b: number): [number, number] {
  const s = new Set([a, b]);
  if (s.has(0) && s.has(1)) return [BUF, 0];
  if (s.has(1) && s.has(2)) return [BUF, BUF];
  if (s.has(2) && s.has(3)) return [0, BUF];
  return [0, 0];
}
const CITY_BUMP_D = BUF * 0.44;
function addEdgeBump(out: Uint8Array, side: number, d: number): void {
  const R = BUF / 2;
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const px = x + 0.5, py = y + 0.5; let hit = false;
      if (side === 0 && py <= d) { const a = (px - R) / R, e = py / d; hit = a * a + e * e <= 1; }
      else if (side === 2 && BUF - py <= d) { const a = (px - R) / R, e = (BUF - py) / d; hit = a * a + e * e <= 1; }
      else if (side === 1 && BUF - px <= d) { const a = (py - R) / R, e = (BUF - px) / d; hit = a * a + e * e <= 1; }
      else if (side === 3 && px <= d) { const a = (py - R) / R, e = px / d; hit = a * a + e * e <= 1; }
      if (hit) out[y * BUF + x] = 1;
    }
}
function buildCityMask(sides: number[]): Uint8Array {
  const mask = new Uint8Array(BUF * BUF), n = sides.length;
  if (n >= 4) { mask.fill(1); return mask; }
  const has = (s: number) => sides.includes(s);
  if (n === 3) {
    const open = ([0, 1, 2, 3] as const).find((s) => !has(s))!;
    const field = new Uint8Array(BUF * BUF); addEdgeBump(field, open, CITY_BUMP_D);
    for (let i = 0; i < mask.length; i++) mask[i] = field[i] ? 0 : 1;
    return mask;
  }
  if (n === 2 && !isOpposite(sides[0], sides[1])) {
    const c = sharedCorner(sides[0], sides[1]), BUMP = BUF * 0.26;
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const dx = Math.abs(x + 0.5 - c[0]), dy = Math.abs(y + 0.5 - c[1]);
        const bulge = BUMP * (1 - Math.abs(dx - dy) / BUF);
        if (dx + dy <= BUF + bulge) mask[y * BUF + x] = 1;
      }
    return mask;
  }
  for (const s of sides) addEdgeBump(mask, s, CITY_BUMP_D);
  const R = BUF / 2, bandHW = BUF * 0.18;
  if (has(0) && has(2)) { for (let y = 0; y < BUF; y++) for (let x = 0; x < BUF; x++) if (Math.abs(x + 0.5 - R) <= bandHW) mask[y * BUF + x] = 1; }
  else if (has(1) && has(3)) { for (let y = 0; y < BUF; y++) for (let x = 0; x < BUF; x++) if (Math.abs(y + 0.5 - R) <= bandHW) mask[y * BUF + x] = 1; }
  return mask;
}
const borderDist = (x: number, y: number): number => Math.min(x, y, BUF - 1 - x, BUF - 1 - y);
function nearBoundary(mask: Uint8Array, x: number, y: number, w: number): boolean {
  for (let dy = -w; dy <= w; dy++)
    for (let dx = -w; dx <= w; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BUF || ny >= BUF) continue;
      if (!mask[ny * BUF + nx]) return true;
    }
  return false;
}
function drawHouse(buf: Buf, hx: number, hy: number, w: number, h: number): void {
  const x = Math.round(hx - w / 2), y = Math.round(hy - h / 2);
  const roofH = Math.max(2, Math.round(h * 0.46)), wallH = h - roofH;
  for (let rx = 1; rx <= w; rx++) setPx(buf, x + rx, y + h, RGB.outlineSoft, 0.55);
  for (let ry = 0; ry < wallH; ry++)
    for (let rx = 0; rx < w; rx++) {
      let col = RGB.wall; if (rx <= 0) col = RGB.wallHi; else if (rx >= w - 1) col = RGB.wallDark;
      setPx(buf, x + rx, y + roofH + ry, col);
    }
  if (w >= 6) { const dx = x + Math.round(w * 0.5) - 1; setPx(buf, dx, y + roofH + wallH - 1, RGB.window); setPx(buf, dx, y + roofH + wallH - 2, RGB.window); }
  if (w >= 5 && wallH >= 3) { const wx = x + Math.round(w * 0.26), wy = y + roofH + Math.max(1, Math.round(wallH * 0.28)); setPx(buf, wx, wy, RGB.windowGlow); setPx(buf, wx + 1, wy, RGB.window); }
  for (let rx = 0; rx < w; rx++) setPx(buf, x + rx, y + roofH, RGB.roofDark);
  for (let ry = 0; ry < wallH; ry++) setPx(buf, x + w - 1, y + roofH + ry, RGB.wallDark);
  const ov = 1;
  for (let ry = 0; ry < roofH; ry++) {
    const inset = Math.round((ry / Math.max(1, roofH - 1)) * (w / 2 + ov - 0.5)) - ov;
    const col = ry === 0 ? RGB.roofHi : ry >= roofH - 1 ? RGB.roofDark : RGB.roof;
    for (let rx = inset; rx < w - inset; rx++) setPx(buf, x + rx, y + ry, col);
    setPx(buf, x + inset, y + ry, ry === 0 ? RGB.roofHi : RGB.roof);
    setPx(buf, x + w - 1 - inset, y + ry, RGB.roofDark);
  }
  setPx(buf, x + ((w / 2) | 0), y, RGB.roofHi);
}
function drawPennant(buf: Buf, cx: number, cy: number): void {
  const w = 7, h = 8, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ms = y > h - 3 ? y - (h - 3) : 0;
      if (x < ms || x >= w - ms) continue;
      let col = RGB.pennant; if (y === 0 || x === ms || x === w - 1 - ms) col = RGB.pennantHi;
      setPx(buf, x0 + x, y0 + y, col);
    }
  for (let y = -1; y <= h; y++)
    for (let x = -1; x <= w; x++) {
      const inside = x >= 0 && x < w && y >= 0 && y < h;
      const ms0 = inside && y > h - 3 ? y - (h - 3) : 0;
      if (inside && x >= ms0 && x < w - ms0) continue;
      let near = false;
      for (const dd of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dd[0], ny = y + dd[1]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ms = ny > h - 3 ? ny - (h - 3) : 0; if (nx >= ms && nx < w - ms) near = true;
      }
      if (near) setPx(buf, x0 + x, y0 + y, RGB.outline);
    }
  setPx(buf, x0 + 3, y0 + 2, RGB.pennantGold); setPx(buf, x0 + 3, y0 + 3, RGB.pennantGold);
  setPx(buf, x0 + 3, y0 + 4, RGB.pennantGold); setPx(buf, x0 + 2, y0 + 3, RGB.pennantGold); setPx(buf, x0 + 4, y0 + 3, RGB.pennantGold);
}
function drawCity(buf: Buf, sides: number[], pennant: boolean, salt: number, maskOverride?: Uint8Array, carve?: Uint8Array): void {
  let mask = maskOverride ?? buildCityMask(sides);
  if (carve) { mask = mask.slice(); for (let i = 0; i < mask.length; i++) if (carve[i]) mask[i] = 0; }
  const full = sides.length >= 4, wallW = 2;
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      if (!mask[y * BUF + x]) continue;
      const isWall = full ? borderDist(x, y) < wallW : nearBoundary(mask, x, y, wallW);
      if (isWall) {
        const r = hash2(x, y, salt + 3); let col = RGB.stone;
        if (r > 0.68) col = RGB.stoneHi; else if (r < 0.26) col = RGB.stoneMid;
        setPx(buf, x, y, col);
      } else {
        const r = hash2(x, y, salt + 9); let col = RGB.cityGround;
        if (r > 0.9) col = RGB.stoneHi; else if (r < 0.16) col = RGB.cityGroundDk;
        else if (((x >> 1) + (y >> 1)) % 5 === 0 && r < 0.55) col = RGB.cityGroundDk;
        setPx(buf, x, y, col);
      }
    }
  for (let y = 2; y < BUF; y += 4)
    for (let x = 0; x < BUF; x++) {
      if (!mask[y * BUF + x]) continue;
      const isWall = full ? borderDist(x, y) < wallW : nearBoundary(mask, x, y, wallW);
      if (isWall) setPx(buf, x, y, RGB.stoneDark);
    }
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      if (mask[y * BUF + x]) continue;
      const touch = (x > 0 && mask[y * BUF + x - 1]) || (x < BUF - 1 && mask[y * BUF + x + 1]) ||
        (y > 0 && mask[(y - 1) * BUF + x]) || (y < BUF - 1 && mask[(y + 1) * BUF + x]);
      if (!touch) continue;
      const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1; if (onEdge) continue;
      if (carve && carve[y * BUF + x]) continue;
      setPx(buf, x, y, (((x >> 1) + (y >> 1)) & 1) ? RGB.stoneHi : RGB.outline);
    }
  if (full) {
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const bd = borderDist(x, y);
        if (bd === wallW) setPx(buf, x, y, (((x >> 1) + (y >> 1)) & 1) ? RGB.stoneHi : RGB.stoneDark);
        if (bd === 0) setPx(buf, x, y, RGB.outline);
      }
  }
  let mx = 0, my = 0, mc = 0;
  for (let y = 0; y < BUF; y++) for (let x = 0; x < BUF; x++) if (mask[y * BUF + x]) { mx += x; my += y; mc++; }
  if (mc === 0) return; mx /= mc; my /= mc;
  const hs = Math.round(BUF * 0.18), n = full ? 4 : sides.length >= 2 ? 3 : 2;
  const placed: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ang = hash2(i, 2, salt + 12) * Math.PI * 2;
    const rad = (0.05 + hash2(i, 5, salt + 33) * 0.4) * BUF * (full ? 0.4 : 0.26);
    let hx = Math.round(mx + Math.cos(ang) * rad), hy = Math.round(my + Math.sin(ang) * rad);
    hx = Math.max(hs, Math.min(BUF - hs, hx)); hy = Math.max(hs, Math.min(BUF - hs, hy));
    if (!mask[hy * BUF + hx] || nearBoundary(mask, hx, hy, 1)) { hx = Math.round(mx); hy = Math.round(my); }
    if (!mask[hy * BUF + hx]) continue;
    let ok = true; for (const p of placed) if (Math.abs(p[0] - hx) < hs && Math.abs(p[1] - hy) < hs) ok = false;
    if (!ok) continue;
    const hw = Math.max(5, Math.round(hs * (0.8 + hash2(i, 7, salt + 51) * 0.5)));
    drawHouse(buf, hx, hy, hw, Math.round(hw * 0.95)); placed.push([hx, hy]);
  }
  if (pennant) {
    const pxc = Math.max(6, Math.min(BUF - 6, Math.round(mx) + Math.round(BUF * 0.14)));
    const pyc = Math.max(7, Math.min(BUF - 7, Math.round(my) - Math.round(BUF * 0.08)));
    drawPennant(buf, pxc, pyc);
  }
}

// ---------------------------------------------------------------------------
// CLOISTER
// ---------------------------------------------------------------------------
function drawCloister(buf: Buf): void {
  const gr = 17;
  for (let a = 0; a < 40; a++) {
    const ang = (a / 40) * Math.PI * 2;
    const bx = Math.round(CX + Math.cos(ang) * gr), by = Math.round(CY + Math.sin(ang) * (gr - 2));
    const dk = (a & 1) === 0;
    setPx(buf, bx, by, dk ? RGB.bush : RGB.bushDark); setPx(buf, bx, by + 1, RGB.bushDark);
    if (dk) setPx(buf, bx + 1, by, RGB.bush);
  }
  const w = 18, h = 16, x = Math.round(CX - w / 2), y = Math.round(CY - h / 2) + 2;
  const roofH = 7, wallH = h - roofH;
  for (let yy = -1; yy <= h; yy++) for (let xx = -1; xx <= w; xx++) if (xx === -1 || yy === -1 || xx === w || yy === h) setPx(buf, x + xx, y + yy, RGB.outline);
  for (let ry = 0; ry < wallH; ry++)
    for (let rx = 0; rx < w; rx++) setPx(buf, x + rx, y + roofH + ry, rx >= w - 1 ? RGB.chapelWallDk : RGB.chapelWall);
  const dw = 4;
  fillRect(buf, x + Math.round((w - dw) / 2), y + roofH + 2, dw, wallH - 2, RGB.chapelRoofDk);
  setPx(buf, x + 3, y + roofH + 2, RGB.window); setPx(buf, x + 3, y + roofH + 3, RGB.window);
  setPx(buf, x + w - 4, y + roofH + 2, RGB.window); setPx(buf, x + w - 4, y + roofH + 3, RGB.window);
  for (let ry = 0; ry < roofH; ry++) {
    const inset = Math.round((ry / (roofH - 1)) * (w / 2 - 1));
    for (let rx = inset; rx < w - inset; rx++) setPx(buf, x + rx, y + ry, ry >= roofH - 1 ? RGB.chapelRoofDk : RGB.chapelRoof);
    if (ry === Math.round(roofH * 0.5)) for (let rx = inset; rx < w - inset; rx++) setPx(buf, x + rx, y + ry, RGB.chapelRoofDk);
  }
  const tx = CX - 1;
  fillRect(buf, tx - 1, y - 6, 4, 8, RGB.chapelWall);
  for (let yy = -7; yy <= 2; yy++) { setPx(buf, tx - 2, y + yy, RGB.outline); setPx(buf, tx + 3, y + yy, RGB.outline); }
  fillRect(buf, tx - 1, y - 6, 4, 2, RGB.chapelRoof);
  setPx(buf, CX, y - 10, RGB.cross); setPx(buf, CX, y - 9, RGB.cross); setPx(buf, CX, y - 8, RGB.cross);
  setPx(buf, CX - 1, y - 9, RGB.cross); setPx(buf, CX + 1, y - 9, RGB.cross);
}

// ---- masks for carving + meeple spots ------------------------------------
function buildRoadMask(sides: number[]): Uint8Array {
  const dist = roadDistField(sides), mask = new Uint8Array(BUF * BUF);
  for (let i = 0; i < mask.length; i++) if (dist[i] <= ROAD_HW + 1) mask[i] = 1;
  return mask;
}
function buildWaterMask(sides: number[]): Uint8Array { return waterMaskAndDist(sides).mask; }
function dilate(mask: Uint8Array, r: number): Uint8Array {
  let m = mask;
  for (let it = 0; it < r; it++) {
    const n = new Uint8Array(BUF * BUF);
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const i = y * BUF + x;
        if (m[i] || (x > 0 && m[i - 1]) || (x < BUF - 1 && m[i + 1]) || (y > 0 && m[i - BUF]) || (y < BUF - 1 && m[i + BUF])) n[i] = 1;
      }
    m = n;
  }
  return m;
}

// ---------------------------------------------------------------------------
// MAIN RENDER -> offscreen canvas (cached)
// ---------------------------------------------------------------------------
function renderBufData(def: TileDef, rot: number): Uint8ClampedArray {
  const buf = newBuf();
  const salt = (def.id.charCodeAt(0) * 31 + (def.id.charCodeAt(1) || 0) * 7 + rot * 101) >>> 0;
  drawGrass(buf, salt);
  const cities: { sides: number[]; pennant: boolean }[] = [];
  const roadSides: number[] = [];
  let hasCloister = false;
  for (const seg of def.segments) {
    const e = rotatedEdges(seg, rot);
    if (seg.kind === "city") cities.push({ sides: e, pennant: seg.pennant === true });
    else if (seg.kind === "road") for (const s of e) roadSides.push(s);
    else if (seg.kind === "cloister") hasCloister = true;
  }
  const riverSides: number[] = [];
  for (let k = 0; k < 4; k++) if (def.edges[k] === "river") riverSides.push(rotSide(k, rot));
  if (riverSides.length) drawRiver(buf, riverSides, salt);
  if (roadSides.length) { drawRoad(buf, roadSides, salt); if (riverSides.length) drawBridge(buf, roadSides, riverSides); }
  // Carve a WIDER grass channel between roads and cities so a farm threading
  // between them (and continuing to the next tile) stays clearly visible.
  const roadCarve = roadSides.length ? dilate(buildRoadMask(roadSides), 3) : undefined;
  if (cities.length <= 1) {
    for (const c of cities) drawCity(buf, c.sides, c.pennant, salt, undefined, roadCarve);
  } else {
    const masks = cities.map((c) => buildCityMask(c.sides));
    const owner = new Int8Array(BUF * BUF).fill(-1);
    for (let p = 0; p < BUF * BUF; p++) {
      const x = (p % BUF) + 0.5, y = ((p / BUF) | 0) + 0.5; let best = -1, bestD = Infinity;
      for (let ci = 0; ci < cities.length; ci++) {
        if (!masks[ci][p]) continue; let dmin = Infinity;
        for (const s of cities[ci].sides) { const e = endpoint(s); const dd = (x - e[0]) ** 2 + (y - e[1]) ** 2; if (dd < dmin) dmin = dd; }
        if (dmin < bestD) { bestD = dmin; best = ci; }
      }
      owner[p] = best;
    }
    const seam = new Uint8Array(BUF * BUF);
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const p = y * BUF + x; if (owner[p] < 0) continue;
        for (const q of [p - 1, p + 1, p - BUF, p + BUF]) if (q >= 0 && q < BUF * BUF && owner[q] >= 0 && owner[q] !== owner[p]) { seam[p] = 1; break; }
      }
    cities.forEach((c, ci) => {
      const m = new Uint8Array(BUF * BUF);
      for (let p = 0; p < BUF * BUF; p++) if (owner[p] === ci && !seam[p]) m[p] = 1;
      drawCity(buf, c.sides, c.pennant, salt, m, roadCarve);
    });
  }
  if (hasCloister) drawCloister(buf);
  // FIELD VERGE: brighten interior grass pixels that touch a non-grass feature
  // (road / city / water / cloister). This traces a crisp light rim around every
  // farm so you can read where a field runs — and, because tile-EDGE grass is
  // left untouched, two tiles' fields still join seamlessly across the border,
  // making it obvious whether a farm continues across tiles.
  if (roadSides.length || cities.length || riverSides.length || hasCloister) {
    const isGrass = (x: number, y: number): boolean => {
      const i = (y * BUF + x) * 4;
      return GRASS_SET.has(`${buf.data[i]},${buf.data[i + 1]},${buf.data[i + 2]}`);
    };
    const verge: number[] = [];
    for (let y = 1; y < BUF - 1; y++)
      for (let x = 1; x < BUF - 1; x++) {
        if (!isGrass(x, y)) continue;
        // border a feature only if the differing neighbour is itself interior
        // (ignore the tile-edge frame ring so cross-tile farms stay connected)
        if (
          (x > 1 && !isGrass(x - 1, y)) || (x < BUF - 2 && !isGrass(x + 1, y)) ||
          (y > 1 && !isGrass(x, y - 1)) || (y < BUF - 2 && !isGrass(x, y + 1))
        ) verge.push(y * BUF + x);
      }
    for (const i of verge) setPx(buf, i % BUF, (i / BUF) | 0, RGB.grassHi, 0.7);
  }
  for (let i = 0; i < BUF; i++) {
    setPx(buf, i, 0, RGB.frame, 0.28); setPx(buf, i, BUF - 1, RGB.frame, 0.28);
    setPx(buf, 0, i, RGB.frame, 0.28); setPx(buf, BUF - 1, i, RGB.frame, 0.28);
  }
  return buf.data;
}

// ---- Offscreen cache ------------------------------------------------------
type CacheEntry = { canvas: HTMLCanvasElement };
const tileCache = new Map<string, CacheEntry>();
export function clearTileCache(): void { tileCache.clear(); meepleSpotCache.clear(); }
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}
function renderToBuffer(def: TileDef, rot: number): HTMLCanvasElement {
  const c = makeCanvas(BUF, BUF);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(BUF, BUF);
  img.data.set(renderBufData(def, rot));
  ctx.putImageData(img, 0, 0);
  return c;
}
function cacheKey(def: TileDef, rot: number): string { return `${def.id}:${rot}`; }
function getBuffer(def: TileDef, rot: number): HTMLCanvasElement {
  const key = cacheKey(def, rot);
  const hit = tileCache.get(key);
  if (hit) return hit.canvas;
  const canvas = renderToBuffer(def, rot);
  tileCache.set(key, { canvas });
  return canvas;
}

// ---------------------------------------------------------------------------
// MEEPLE SPOT (same contract as original)
// ---------------------------------------------------------------------------
const NODE_MID: Record<number, [number, number]> = {
  0: [0.3, 0.03], 1: [0.7, 0.03], 2: [0.97, 0.3], 3: [0.97, 0.7],
  4: [0.7, 0.97], 5: [0.3, 0.97], 6: [0.03, 0.7], 7: [0.03, 0.3],
};
function poleOfInaccessibility(mask: Uint8Array): { x: number; y: number } {
  const dist = new Int32Array(BUF * BUF).fill(-1); const q: number[] = [];
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const i = y * BUF + x;
      if (!mask[i] || x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1) { dist[i] = 0; q.push(i); }
    }
  let head = 0;
  while (head < q.length) {
    const i = q[head++], x = i % BUF, y = (i / BUF) | 0, d = dist[i];
    if (x > 0 && mask[i - 1] && dist[i - 1] < 0) { dist[i - 1] = d + 1; q.push(i - 1); }
    if (x < BUF - 1 && mask[i + 1] && dist[i + 1] < 0) { dist[i + 1] = d + 1; q.push(i + 1); }
    if (y > 0 && mask[i - BUF] && dist[i - BUF] < 0) { dist[i - BUF] = d + 1; q.push(i - BUF); }
    if (y < BUF - 1 && mask[i + BUF] && dist[i + BUF] < 0) { dist[i + BUF] = d + 1; q.push(i + BUF); }
  }
  let best = -1, bx = (BUF / 2) | 0, by = (BUF / 2) | 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > best) { best = dist[i]; bx = i % BUF; by = (i / BUF) | 0; }
  return { x: (bx + 0.5) / BUF, y: (by + 0.5) / BUF };
}
function roadSpot(sides: number[]): { x: number; y: number } {
  const bones = buildBones(sides); const pts: [number, number][] = [[bones[0][0], bones[0][1]]];
  for (const bn of bones) pts.push([bn[2], bn[3]]);
  let total = 0; const seglen: number[] = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seglen.push(l); total += l; }
  let acc = 0, px = pts[0][0], py = pts[0][1]; const target = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = seglen[i - 1];
    if (acc + l >= target) { const f = (target - acc) / (l || 1); px = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f; py = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f; break; }
    acc += l;
  }
  return { x: px / BUF, y: py / BUF };
}
function fieldSpot(def: TileDef, rotation: number, seg: Segment): { x: number; y: number } {
  const blocked = new Uint8Array(BUF * BUF);
  const add = (m: Uint8Array) => { for (let i = 0; i < m.length; i++) if (m[i]) blocked[i] = 1; };
  const citySides: number[] = [], roadSides: number[] = [], riverSides: number[] = [];
  let hasCloister = false;
  for (const s of def.segments) {
    if (s.kind === "city") for (const k of s.edges) citySides.push(rotSide(k, rotation));
    else if (s.kind === "road") for (const k of s.edges) roadSides.push(rotSide(k, rotation));
    else if (s.kind === "cloister") hasCloister = true;
  }
  for (let k = 0; k < 4; k++) if (def.edges[k] === "river") riverSides.push(rotSide(k, rotation));
  if (citySides.length) add(buildCityMask(citySides));
  if (roadSides.length) add(buildRoadMask(roadSides));
  if (riverSides.length) add(buildWaterMask(riverSides));
  if (hasCloister) { const r = Math.round(BUF * 0.26); for (let y = CY - r; y < CY + r; y++) for (let x = CX - r; x < CX + r; x++) if (x >= 0 && y >= 0 && x < BUF && y < BUF) blocked[y * BUF + x] = 1; }
  let seed = -1;
  for (const un of seg.edges) {
    const nm = NODE_MID[rotHalf(un, rotation)];
    for (let t = 0.08; t < 0.5 && seed < 0; t += 0.05) {
      const sx = Math.round((nm[0] + (0.5 - nm[0]) * t) * BUF), sy = Math.round((nm[1] + (0.5 - nm[1]) * t) * BUF);
      if (sx >= 0 && sy >= 0 && sx < BUF && sy < BUF && !blocked[sy * BUF + sx]) seed = sy * BUF + sx;
    }
    if (seed >= 0) break;
  }
  if (seed < 0) for (let i = 0; i < blocked.length; i++) if (!blocked[i]) { seed = i; break; }
  if (seed < 0) return { x: 0.5, y: 0.5 };
  const comp = new Uint8Array(BUF * BUF); const q = [seed]; comp[seed] = 1; let head = 0;
  while (head < q.length) {
    const i = q[head++], x = i % BUF, y = (i / BUF) | 0;
    if (x > 0 && !blocked[i - 1] && !comp[i - 1]) { comp[i - 1] = 1; q.push(i - 1); }
    if (x < BUF - 1 && !blocked[i + 1] && !comp[i + 1]) { comp[i + 1] = 1; q.push(i + 1); }
    if (y > 0 && !blocked[i - BUF] && !comp[i - BUF]) { comp[i - BUF] = 1; q.push(i - BUF); }
    if (y < BUF - 1 && !blocked[i + BUF] && !comp[i + BUF]) { comp[i + BUF] = 1; q.push(i + BUF); }
  }
  return poleOfInaccessibility(comp);
}
const meepleSpotCache = new Map<string, { x: number; y: number }>();
export function computeMeepleSpot(def: TileDef, rotation: number, segIndex: number): { x: number; y: number } {
  const key = `${def.id}:${rotation}:${segIndex}`;
  const hit = meepleSpotCache.get(key);
  if (hit) return hit;
  const seg = def.segments[segIndex];
  let res: { x: number; y: number };
  if (!seg || seg.kind === "cloister") res = { x: 0.5, y: 0.5 };
  else if (seg.kind === "city") res = poleOfInaccessibility(buildCityMask(seg.edges.map((k) => rotSide(k, rotation))));
  else if (seg.kind === "road") res = roadSpot(seg.edges.map((k) => rotSide(k, rotation)));
  else res = fieldSpot(def, rotation, seg);
  meepleSpotCache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// PUBLIC
// ---------------------------------------------------------------------------
export interface DrawTileOpts { ghost?: boolean; highlight?: boolean; }

export function drawTile(
  ctx: CanvasRenderingContext2D,
  def: TileDef,
  rotation: Rotation,
  x: number,
  y: number,
  size: number,
  opts?: DrawTileOpts
): void {
  const buf = getBuffer(def, rotation);
  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false; // CRISP pixels (Celeste style)
  if (opts?.ghost) ctx.globalAlpha = 0.55;
  ctx.drawImage(buf, 0, 0, BUF, BUF, Math.round(x), Math.round(y), size, size);
  if (opts?.ghost) ctx.globalAlpha = 1;
  if (opts?.highlight) {
    ctx.save();
    ctx.strokeStyle = PX.highlightEdge;
    ctx.lineWidth = Math.max(2, Math.round(size * 0.03));
    const inset = ctx.lineWidth / 2;
    ctx.shadowColor = PX.highlight;
    ctx.shadowBlur = size * 0.14;
    ctx.strokeRect(Math.round(x) + inset, Math.round(y) + inset, size - ctx.lineWidth, size - ctx.lineWidth);
    ctx.restore();
  }
  ctx.imageSmoothingEnabled = prevSmoothing;
}

export function prewarmTile(def: TileDef, rotation: Rotation): void { getBuffer(def, rotation); }
export const TILE_BUFFER_RES = BUF;
