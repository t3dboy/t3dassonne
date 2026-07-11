// ============================================================================
// T3dassonne — tile renderer, styled to resemble the real Carcassonne tiles:
// muted olive fields with little trees, pale sandy roads that curve smoothly,
// warm-grey crenellated stone cities with terracotta roofs & heraldic shields,
// and blue rivers. Rendered into a high-res offscreen buffer and blitted with
// smoothing ON for a soft, painted look (not chunky pixels).
//
// Rotation model (matches engine):  side k -> (k+rot)%4 ;  halfEdge h -> (h+2rot)%8
// Segment.edges are stored UNROTATED; rotated here for drawing.
// ============================================================================

import type { Rotation, Segment, TileDef } from "../core/types";
import { PALETTE, shade } from "./palette";

/** Internal buffer resolution (px). High enough for detail; downscaled soft. */
const BUF = 128;
const CX = BUF / 2;
const CY = BUF / 2;

// ---- Deterministic pseudo-random (so cached art is stable) ----------------
function hash2(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// ---- Rotation helpers -----------------------------------------------------
const rotSide = (k: number, rot: number): number => (k + rot) % 4;
const rotHalf = (h: number, rot: number): number => (h + 2 * rot) % 8;
function rotatedEdges(seg: Segment, rot: number): number[] {
  if (seg.kind === "field") return seg.edges.map((h) => rotHalf(h, rot));
  if (seg.kind === "cloister") return [];
  return seg.edges.map((k) => rotSide(k, rot));
}

const SIDE_MIDPT: Record<number, [number, number]> = {
  0: [0.5, 0.0], // N
  1: [1.0, 0.5], // E
  2: [0.5, 1.0], // S
  3: [0.0, 0.5], // W
};

// ---- Offscreen cache ------------------------------------------------------
type CacheEntry = { canvas: HTMLCanvasElement };
const tileCache = new Map<string, CacheEntry>();
export function clearTileCache(): void {
  tileCache.clear();
  meepleSpotCache.clear();
}
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// ---- Low-level helpers ----------------------------------------------------
interface Buf {
  ctx: CanvasRenderingContext2D;
}
function px(b: Buf, x: number, y: number, color: string): void {
  if (x < 0 || y < 0 || x >= BUF || y >= BUF) return;
  b.ctx.fillStyle = color;
  b.ctx.fillRect(x | 0, y | 0, 1, 1);
}
function rect(b: Buf, x: number, y: number, w: number, h: number, color: string): void {
  b.ctx.fillStyle = color;
  b.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function circle(b: Buf, cx: number, cy: number, r: number, color: string): void {
  b.ctx.fillStyle = color;
  b.ctx.beginPath();
  b.ctx.arc(cx, cy, r, 0, Math.PI * 2);
  b.ctx.fill();
}
function distToSeg(px2: number, py2: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax,
    vy = by - ay,
    wx = px2 - ax,
    wy = py2 - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px2 - (ax + t * vx),
    dy = py2 - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}
const isOpposite = (a: number, b: number) => (a + 2) % 4 === b;
const endpoint = (s: number): [number, number] => {
  const [ux, uy] = SIDE_MIDPT[s];
  return [ux * BUF, uy * BUF];
};

/** Build the centre-line "bones" (poly-line segments) for a feature that runs
 *  from each active side toward the tile centre. Shared by roads & rivers. */
function buildBones(sides: number[]): [number, number, number, number][] {
  const bones: [number, number, number, number][] = [];
  if (sides.length === 2 && isOpposite(sides[0], sides[1])) {
    const [ax, ay] = endpoint(sides[0]);
    const [bx, by] = endpoint(sides[1]);
    bones.push([ax, ay, bx, by]);
  } else if (sides.length === 2) {
    // Smooth 90° bend between two adjacent edges. The control point is the tile
    // CENTRE (not the corner): that makes the curve approximate a quarter-circle
    // centred on the shared corner, so it crosses each edge PERPENDICULAR and
    // sweeps cleanly — instead of the old kinked "L" that ran along the edges.
    const [ax, ay] = endpoint(sides[0]);
    const [bx, by] = endpoint(sides[1]);
    const ctrlX = CX,
      ctrlY = CY;
    const STEPS = 16;
    let prevX = ax,
      prevY = ay;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS,
        mt = 1 - t;
      const qx = mt * mt * ax + 2 * mt * t * ctrlX + t * t * bx;
      const qy = mt * mt * ay + 2 * mt * t * ctrlY + t * t * by;
      bones.push([prevX, prevY, qx, qy]);
      prevX = qx;
      prevY = qy;
    }
  } else {
    // 1 side (dead-end -> centre) or 3+ (junction through centre)
    for (const s of sides) {
      const [ex, ey] = endpoint(s);
      bones.push([ex, ey, CX, CY]);
    }
  }
  return bones;
}

// ---------------------------------------------------------------------------
// GRASS / FIELDS
// ---------------------------------------------------------------------------
function drawGrassBase(b: Buf, salt: number): void {
  const ctx = b.ctx;
  // vertical gradient base (lit top -> shaded bottom)
  const g = ctx.createLinearGradient(0, 0, 0, BUF);
  g.addColorStop(0, PALETTE.grassLight);
  g.addColorStop(0.4, PALETTE.grassMid);
  g.addColorStop(1, PALETTE.grassDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BUF, BUF);
  // soft mottled patches for a painted texture (pure soft blobs — these read as
  // grassy variation, never as discrete objects/structures)
  for (let i = 0; i < 52; i++) {
    const x = hash2(i, 1, salt + 7) * BUF;
    const y = hash2(i, 2, salt + 7) * BUF;
    const r = 6 + hash2(i, 3, salt + 7) * 17;
    const t = hash2(i, 4, salt + 7);
    ctx.globalAlpha = 0.08 + hash2(i, 5, salt + 7) * 0.13;
    ctx.fillStyle = t > 0.62 ? PALETTE.grassLight : t > 0.24 ? PALETTE.grassDeep : PALETTE.treeDark;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// ROADS — pale sandy paths (smooth curves), soft borders, faint cobbles.
// ---------------------------------------------------------------------------
const ROAD_HW = Math.round(BUF * 0.07);

function drawRoadSegment(b: Buf, sides: number[], salt: number): void {
  const hw = ROAD_HW;
  const bones = buildBones(sides);
  const isRoad = new Uint8Array(BUF * BUF);
  const dist = new Float32Array(BUF * BUF);
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const [ax, ay, bx, by] of bones) {
        const dd = distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
        if (dd < d) d = dd;
      }
      // rounded dead-end / junction cap at centre
      const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      if (sides.length !== 2 && dc < d) d = Math.max(0, dc - hw * 0.2);
      if (d <= hw + 1.5) {
        isRoad[y * BUF + x] = 1;
        dist[y * BUF + x] = d;
      }
    }
  }
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      if (!isRoad[y * BUF + x]) continue;
      const t = dist[y * BUF + x] / hw;
      let col: string;
      if (t > 1.0) col = PALETTE.roadEdge; // outer rim
      else if (t > 0.66) col = PALETTE.roadDark;
      else if (t < 0.3) col = PALETTE.roadLight;
      else col = PALETTE.roadMid;
      // faint cobble speckle
      const r = hash2(x, y, salt + 5);
      if (t < 0.85 && r > 0.93) col = PALETTE.roadDark;
      px(b, x, y, col);
    }
  }

  // Junction plaza: where 3+ roads meet, draw a distinct round cobbled node with
  // a dark stone rim so the roads clearly TERMINATE at a junction instead of
  // looking like they run straight through a crossroads.
  if (sides.length >= 3) {
    const pr = Math.round(hw * 2.1);
    for (let y = CY - pr - 2; y <= CY + pr + 2; y++)
      for (let x = CX - pr - 2; x <= CX + pr + 2; x++) {
        if (x < 0 || y < 0 || x >= BUF || y >= BUF) continue;
        const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
        if (dc <= pr) {
          const r = hash2(x, y, salt + 9);
          px(b, x, y, r > 0.86 ? PALETTE.roadLight : r < 0.2 ? PALETTE.roadDark : PALETTE.roadMid);
        } else if (dc <= pr + 1.8) {
          px(b, x, y, PALETTE.roadEdge); // dark stone rim
        }
      }
  }
}

/**
 * Wooden bridge planks — only on the stretch of road that ACTUALLY overlaps the
 * water. (Previously planks were stamped on every road arm of any road+river
 * tile, so a road that never crosses the river got a stray bridge on dry land.)
 */
function drawBridgePlanks(b: Buf, roadSides: number[], riverSides: number[]): void {
  if (riverSides.length < 2) return; // source/lake tiles carry no through-road
  const hw = ROAD_HW + 1;
  const bones = buildBones(riverSides);
  const overWater = (x: number, y: number): boolean => {
    let d = Infinity;
    for (const [ax, ay, bx, by] of bones) d = Math.min(d, distToSeg(x, y, ax, ay, bx, by));
    return d <= RIVER_HW + 1;
  };
  const span = Math.round(BUF * 0.32);
  for (const s of roadSides) {
    const horiz = s === 1 || s === 3;
    let planked = false;
    for (let d = 0; d <= span; d += 4) {
      const x = s === 1 ? CX + d : s === 3 ? CX - d : CX;
      const y = s === 0 ? CY - d : s === 2 ? CY + d : CY;
      if (!overWater(x, y)) continue;
      planked = true;
      if (horiz) {
        rect(b, x, CY - hw, 1.5, hw * 2, PALETTE.woodDark);
        rect(b, x + 1.5, CY - hw, 1.2, hw * 2, PALETTE.woodMid);
      } else {
        rect(b, CX - hw, y, hw * 2, 1.5, PALETTE.woodDark);
        rect(b, CX - hw, y + 1.5, hw * 2, 1.2, PALETTE.woodMid);
      }
    }
    // light rails along the wet stretch for a finished bridge look
    if (planked) {
      if (horiz) {
        rect(b, s === 1 ? CX : CX - span, CY - hw - 1, span, 1.4, PALETTE.woodLight);
        rect(b, s === 1 ? CX : CX - span, CY + hw, span, 1.4, PALETTE.woodTrim);
      } else {
        rect(b, CX - hw - 1, s === 2 ? CY : CY - span, 1.4, span, PALETTE.woodLight);
        rect(b, CX + hw, s === 2 ? CY : CY - span, 1.4, span, PALETTE.woodTrim);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RIVER / WATER
// ---------------------------------------------------------------------------
const RIVER_HW = Math.round(BUF * 0.15);
function waterColorAt(x: number, y: number, d: number, hw: number, salt: number): string {
  const t = d / hw;
  const r = hash2(x, y, salt + 61);
  const ripple = hash2(x + Math.floor(y / 3), y, salt + 71);
  if (t < 0.34) {
    if (ripple > 0.86) return PALETTE.waterLight;
    return r > 0.9 ? PALETTE.waterLight : PALETTE.waterMid;
  }
  if (t < 0.72) {
    if (ripple > 0.95) return PALETTE.waterLight;
    return r < 0.14 ? PALETTE.waterDeep : PALETTE.waterMid;
  }
  return r < 0.3 ? PALETTE.waterEdge : PALETTE.waterDeep;
}
function drawRiverSegment(b: Buf, sides: number[], salt: number): void {
  const hw = RIVER_HW;
  const bones: [number, number, number, number][] = [];
  let lake: { x: number; y: number; r: number } | null = null;
  if (sides.length === 1) {
    const [ex, ey] = endpoint(sides[0]);
    const dirX = CX - ex,
      dirY = CY - ey;
    const len = Math.hypot(dirX, dirY) || 1;
    const lx = CX + (dirX / len) * hw * 1.1;
    const ly = CY + (dirY / len) * hw * 1.1;
    bones.push([ex, ey, lx, ly]);
    lake = { x: lx, y: ly, r: Math.round(hw * 1.5) };
  } else {
    for (const bn of buildBones(sides)) bones.push(bn);
  }
  const isWater = new Uint8Array(BUF * BUF);
  const distField = new Float32Array(BUF * BUF);
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const [ax, ay, bx, by] of bones) {
        const dd = distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
        if (dd < d) d = dd;
      }
      if (lake) {
        const dl = Math.hypot(x + 0.5 - lake.x, y + 0.5 - lake.y) - lake.r;
        if (dl < d) d = dl < 0 ? 0 : dl;
      }
      if (d <= hw) {
        isWater[y * BUF + x] = 1;
        distField[y * BUF + x] = d;
      }
    }
  }
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++)
      if (isWater[y * BUF + x]) px(b, x, y, waterColorAt(x, y, distField[y * BUF + x], hw, salt));
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      if (!isWater[y * BUF + x]) continue;
      const border =
        (x > 0 && !isWater[y * BUF + x - 1]) ||
        (x < BUF - 1 && !isWater[y * BUF + x + 1]) ||
        (y > 0 && !isWater[(y - 1) * BUF + x]) ||
        (y < BUF - 1 && !isWater[(y + 1) * BUF + x]);
      const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1;
      if (border && !onEdge) px(b, x, y, PALETTE.waterBank);
    }
  }
  if (lake) {
    const r2 = Math.round(lake.r * 0.55);
    for (let y = lake.y - r2; y <= lake.y + r2; y++)
      for (let x = lake.x - r2; x <= lake.x + r2; x++) {
        const dx = x - lake.x + 0.5,
          dy = y - lake.y + 0.5;
        if (dx * dx + dy * dy <= r2 * r2 && isWater[y * BUF + x])
          px(b, x, y, hash2(x, y, salt + 81) > 0.4 ? PALETTE.waterLight : PALETTE.waterMid);
      }
  }
}

// ---------------------------------------------------------------------------
// CITY — organic bulging stone mass, crenellated wall, terracotta roofs.
// ---------------------------------------------------------------------------
/** The corner (px coords) shared by two ADJACENT city edges. */
function sharedCorner(a: number, b: number): [number, number] {
  const s = new Set([a, b]);
  if (s.has(0) && s.has(1)) return [BUF, 0]; // N+E → NE
  if (s.has(1) && s.has(2)) return [BUF, BUF]; // E+S → SE
  if (s.has(2) && s.has(3)) return [0, BUF]; // S+W → SW
  return [0, 0]; // W+N → NW
}

/** Rounded HALF-ELLIPSE bump for ONE edge: its base spans the full edge (touches
 *  both of that edge's corners) and it bulges `d` inward. Used for city bumps and
 *  (inverted) for the field bump of a 3-sided city. Writes 1s into `out`. */
const CITY_BUMP_D = BUF * 0.42;
function addEdgeBump(out: Uint8Array, side: number, d: number): void {
  const R = BUF / 2;
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      let hit = false;
      if (side === 0 && py <= d) { const a = (px - R) / R, e = py / d; hit = a * a + e * e <= 1; } // N
      else if (side === 2 && BUF - py <= d) { const a = (px - R) / R, e = (BUF - py) / d; hit = a * a + e * e <= 1; } // S
      else if (side === 1 && BUF - px <= d) { const a = (py - R) / R, e = (BUF - px) / d; hit = a * a + e * e <= 1; } // E
      else if (side === 3 && px <= d) { const a = (py - R) / R, e = px / d; hit = a * a + e * e <= 1; } // W
      if (hit) out[y * BUF + x] = 1;
    }
  }
}

function buildCityMask(sides: number[]): Uint8Array {
  const mask = new Uint8Array(BUF * BUF);
  const n = sides.length;
  if (n >= 4) {
    mask.fill(1); // a city on all sides fills the whole tile
    return mask;
  }
  const has = (s: number) => sides.includes(s);

  // 3 edges: the whole tile is city EXCEPT a rounded field bump poking in from
  // the one open edge — the clean way to draw a three-sided city.
  if (n === 3) {
    const open = ([0, 1, 2, 3] as const).find((s) => !has(s))!;
    const field = new Uint8Array(BUF * BUF);
    addEdgeBump(field, open, CITY_BUMP_D);
    for (let i = 0; i < mask.length; i++) mask[i] = field[i] ? 0 : 1;
    return mask;
  }

  // 2 ADJACENT edges: ONE diagonal city hugging the shared corner. The wall is a
  // gently-bulged straight line running from one far corner to the other, so the
  // city touches both its edges fully and reads as a single diagonal mass (not
  // two semicircles, and no spiky wedges).
  if (n === 2 && !isOpposite(sides[0], sides[1])) {
    const [sx, sy] = sharedCorner(sides[0], sides[1]);
    const BUMP = BUF * 0.26;
    for (let y = 0; y < BUF; y++) {
      for (let x = 0; x < BUF; x++) {
        const dx = Math.abs(x + 0.5 - sx),
          dy = Math.abs(y + 0.5 - sy);
        const bulge = BUMP * (1 - Math.abs(dx - dy) / BUF); // max mid-wall, 0 at corners
        if (dx + dy <= BUF + bulge) mask[y * BUF + x] = 1;
      }
    }
    return mask;
  }

  // 1 edge, or 2 OPPOSITE edges: half-ellipse bump(s), plus a waist band across
  // the middle so an opposite-edge city stays one joined mass.
  for (const s of sides) addEdgeBump(mask, s, CITY_BUMP_D);
  const R = BUF / 2;
  const bandHW = BUF * 0.17;
  if (has(0) && has(2)) {
    for (let y = 0; y < BUF; y++) for (let x = 0; x < BUF; x++) if (Math.abs(x + 0.5 - R) <= bandHW) mask[y * BUF + x] = 1;
  } else if (has(1) && has(3)) {
    for (let y = 0; y < BUF; y++) for (let x = 0; x < BUF; x++) if (Math.abs(y + 0.5 - R) <= bandHW) mask[y * BUF + x] = 1;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// MEEPLE SPOT — the accurate on-tile position (0..1) for a segment's meeple,
// computed from the SAME geometry the renderer draws so the follower always
// sits clearly on its feature (deep inside the city stone / on the grass / on
// the road), never on a boundary line.
// ---------------------------------------------------------------------------

// half-edge midpoints (0..1) near the tile edges, for seeding field regions
const NODE_MID: Record<number, [number, number]> = {
  0: [0.3, 0.03], 1: [0.7, 0.03], 2: [0.97, 0.3], 3: [0.97, 0.7],
  4: [0.7, 0.97], 5: [0.3, 0.97], 6: [0.03, 0.7], 7: [0.03, 0.3],
};

/** Grow a boolean mask outward by `r` cells (4-neighbour). */
function dilate(mask: Uint8Array, r: number): Uint8Array {
  let m = mask;
  for (let it = 0; it < r; it++) {
    const n = new Uint8Array(BUF * BUF);
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const i = y * BUF + x;
        if (
          m[i] ||
          (x > 0 && m[i - 1]) ||
          (x < BUF - 1 && m[i + 1]) ||
          (y > 0 && m[i - BUF]) ||
          (y < BUF - 1 && m[i + BUF])
        )
          n[i] = 1;
      }
    m = n;
  }
  return m;
}

/** Road-band mask for a set of (rotated) road sides. */
function buildRoadMask(sides: number[]): Uint8Array {
  const mask = new Uint8Array(BUF * BUF);
  const bones = buildBones(sides);
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const [ax, ay, bx, by] of bones) {
        const dd = distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
        if (dd < d) d = dd;
      }
      const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      if (sides.length !== 2 && dc < d) d = Math.max(0, dc - ROAD_HW * 0.2);
      if (d <= ROAD_HW + 1.5) mask[y * BUF + x] = 1;
    }
  return mask;
}

/** Meeple spot for a road segment: the midpoint (by arc length) of the road's
 *  path — always ON the road, and away from a junction centre so a junction's
 *  arms don't stack. */
function roadSpot(sides: number[]): { x: number; y: number } {
  const bones = buildBones(sides);
  const pts: [number, number][] = [[bones[0][0], bones[0][1]]];
  for (const [, , bx, by] of bones) pts.push([bx, by]);
  const seglen: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seglen.push(l);
    total += l;
  }
  let acc = 0, px = pts[0][0], py = pts[0][1];
  const target = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = seglen[i - 1];
    if (acc + l >= target) {
      const f = (target - acc) / (l || 1);
      px = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
      py = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
      break;
    }
    acc += l;
  }
  return { x: px / BUF, y: py / BUF };
}

/** Water mask for a set of (rotated) river sides (matches drawRiverSegment). */
function buildWaterMask(sides: number[]): Uint8Array {
  const hw = RIVER_HW;
  const bones: [number, number, number, number][] = [];
  let lake: { x: number; y: number; r: number } | null = null;
  if (sides.length === 1) {
    const [ex, ey] = endpoint(sides[0]);
    const dirX = CX - ex, dirY = CY - ey, len = Math.hypot(dirX, dirY) || 1;
    const lx = CX + (dirX / len) * hw * 1.1, ly = CY + (dirY / len) * hw * 1.1;
    bones.push([ex, ey, lx, ly]);
    lake = { x: lx, y: ly, r: Math.round(hw * 1.5) };
  } else {
    for (const bn of buildBones(sides)) bones.push(bn);
  }
  const mask = new Uint8Array(BUF * BUF);
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      let d = Infinity;
      for (const [ax, ay, bx, by] of bones) {
        const dd = distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
        if (dd < d) d = dd;
      }
      if (lake) {
        const dl = Math.hypot(x + 0.5 - lake.x, y + 0.5 - lake.y) - lake.r;
        if (dl < d) d = dl < 0 ? 0 : dl;
      }
      if (d <= hw) mask[y * BUF + x] = 1;
    }
  return mask;
}

/** Most-interior point of a mask (farthest from any non-mask cell OR the tile
 *  border) — a clean, central position guaranteed to be on the feature. */
function poleOfInaccessibility(mask: Uint8Array): { x: number; y: number } {
  const dist = new Int32Array(BUF * BUF).fill(-1);
  const q: number[] = [];
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++) {
      const i = y * BUF + x;
      if (!mask[i] || x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1) {
        dist[i] = 0;
        q.push(i);
      }
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
  for (let i = 0; i < dist.length; i++)
    if (dist[i] > best) { best = dist[i]; bx = i % BUF; by = (i / BUF) | 0; }
  return { x: (bx + 0.5) / BUF, y: (by + 0.5) / BUF };
}

/** Accurate spot for a field segment: flood-fill its grass region (fields are
 *  split by roads / cities / water / the cloister), then take its interior. */
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
  if (hasCloister) {
    const r = Math.round(BUF * 0.24);
    for (let y = CY - r; y < CY + r; y++)
      for (let x = CX - r; x < CX + r; x++)
        if (x >= 0 && y >= 0 && x < BUF && y < BUF) blocked[y * BUF + x] = 1;
  }
  // seed a grass cell near one of this segment's edge nodes
  let seed = -1;
  for (const un of seg.edges) {
    const [hx, hy] = NODE_MID[rotHalf(un, rotation)];
    for (let t = 0.08; t < 0.5 && seed < 0; t += 0.05) {
      const sx = Math.round((hx + (0.5 - hx) * t) * BUF), sy = Math.round((hy + (0.5 - hy) * t) * BUF);
      if (sx >= 0 && sy >= 0 && sx < BUF && sy < BUF && !blocked[sy * BUF + sx]) seed = sy * BUF + sx;
    }
    if (seed >= 0) break;
  }
  if (seed < 0) for (let i = 0; i < blocked.length; i++) if (!blocked[i]) { seed = i; break; }
  if (seed < 0) return { x: 0.5, y: 0.5 };
  const comp = new Uint8Array(BUF * BUF);
  const q = [seed];
  comp[seed] = 1;
  let head = 0;
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

/** Accurate 0..1 on-tile position where segment `segIndex`'s meeple should sit,
 *  for the given rotation. Cached per (tile, rotation, segment). */
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

/** Distance (Chebyshev) from the tile border. */
const borderDist = (x: number, y: number) => Math.min(x, y, BUF - 1 - x, BUF - 1 - y);

/** Is (x,y) within Chebyshev distance `w` of a non-city cell (i.e. near the wall)? */
function nearBoundary(mask: Uint8Array, x: number, y: number, w: number): boolean {
  for (let dy = -w; dy <= w; dy++)
    for (let dx = -w; dx <= w; dx++) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= BUF || ny >= BUF) continue; // tile edge = not a wall
      if (!mask[ny * BUF + nx]) return true;
    }
  return false;
}

function drawHouse(b: Buf, hx: number, hy: number, w: number, h: number, salt: number): void {
  const x = Math.round(hx - w / 2);
  const y = Math.round(hy - h / 2);
  const roofH = Math.round(h * 0.52);
  const wallH = h - roofH;
  // soft shadow
  b.ctx.globalAlpha = 0.2;
  b.ctx.fillStyle = PALETTE.stoneShadow;
  b.ctx.beginPath();
  b.ctx.ellipse(hx, y + h, w * 0.6, 2.4, 0, 0, Math.PI * 2);
  b.ctx.fill();
  b.ctx.globalAlpha = 1;
  // wall (plaster) with door + window
  rect(b, x, y + roofH, w, wallH, PALETTE.houseWall);
  rect(b, x, y + roofH, 1, wallH, PALETTE.houseWallDark);
  rect(b, x + w - 1, y + roofH, 1, wallH, PALETTE.houseWallDark);
  rect(b, x + Math.round(w * 0.4), y + roofH + Math.round(wallH * 0.35), Math.max(1, Math.round(w * 0.24)), Math.round(wallH * 0.6), PALETTE.window);
  // roof (terracotta triangle) with ridge highlight + eave shadow
  for (let ry = 0; ry < roofH; ry++) {
    const inset = Math.round((ry / roofH) * (w / 2 - 0.5));
    const col = ry <= 1 ? PALETTE.roofLight : ry >= roofH - 1 ? PALETTE.roofDark : PALETTE.roofMid;
    rect(b, x + inset, y + ry, w - inset * 2, 1, col);
  }
  rect(b, x, y + roofH, w, 1, PALETTE.roofDark); // eave line
  void salt;
  outlineRect(b, x, y, w, h);
}

function outlineRect(b: Buf, x: number, y: number, w: number, h: number): void {
  b.ctx.strokeStyle = PALETTE.outline;
  b.ctx.lineWidth = 1;
  b.ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
}

/** A heraldic blue shield (pennant). */
function drawPennant(b: Buf, cx: number, cy: number): void {
  const ctx = b.ctx;
  const w = 11,
    h = 13;
  ctx.save();
  ctx.translate(cx, cy);
  // shield shape
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 2);
  ctx.lineTo(w / 2, h * 0.12);
  ctx.quadraticCurveTo(w / 2, h / 2, 0, h / 2);
  ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h * 0.12);
  ctx.closePath();
  ctx.fillStyle = PALETTE.pennantField;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = PALETTE.pennantEdge;
  ctx.stroke();
  // simple gold emblem (cross)
  ctx.fillStyle = PALETTE.pennantEdge;
  ctx.fillRect(-1, -4, 2, 8);
  ctx.fillRect(-3.5, -1.5, 7, 2);
  ctx.restore();
}

function drawCitySegment(
  b: Buf,
  sides: number[],
  pennant: boolean,
  salt: number,
  maskOverride?: Uint8Array,
  carve?: Uint8Array
): void {
  let mask = maskOverride ?? buildCityMask(sides);
  // Never paint city over the road (roads draw first): subtract the road band
  // so the wall stops at a clean grassy verge instead of covering the road.
  if (carve) {
    mask = mask.slice();
    for (let i = 0; i < mask.length; i++) if (carve[i]) mask[i] = 0;
  }
  const full = sides.length >= 4;
  const wallW = Math.round(BUF * 0.04);

  // interior ground + wall band. For a fully-enclosed (4-side) city there is no
  // field boundary, so the wall runs as a ring just inside the tile border.
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      if (!mask[y * BUF + x]) continue;
      const isWall = full ? borderDist(x, y) < wallW : nearBoundary(mask, x, y, wallW);
      if (isWall) {
        // stone wall, top-lit shading + occasional dark mortar fleck
        const r = hash2(x, y, salt + 3);
        let col: string = PALETTE.stoneMid;
        if (r > 0.7) col = PALETTE.stoneLight;
        else if (r < 0.24) col = PALETTE.stoneDark;
        px(b, x, y, col);
      } else {
        const r = hash2(x, y, salt + 9);
        px(b, x, y, r > 0.94 ? PALETTE.stoneLight : PALETTE.cityGround);
      }
    }
  }

  // mortar courses on the wall band
  for (let y = 3; y < BUF; y += 5)
    for (let x = 0; x < BUF; x++) {
      const isWall = full ? borderDist(x, y) < wallW : mask[y * BUF + x] === 1 && nearBoundary(mask, x, y, wallW);
      if (isWall) px(b, x, y, PALETTE.stoneShadow);
    }

  // full-city crenellations: a toothed inner edge on the perimeter wall ring
  if (full) {
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const bd = borderDist(x, y);
        if (bd >= wallW && bd < wallW + 2) px(b, x, y, (x + y) % 4 < 2 ? PALETTE.stoneLight : PALETTE.outline);
      }
  }

  // crenellations: merlon "teeth" poking into the field along the boundary
  for (let y = 0; y < BUF; y++) {
    for (let x = 0; x < BUF; x++) {
      if (mask[y * BUF + x]) continue;
      // field cell touching the wall
      const touch =
        (x > 0 && mask[y * BUF + x - 1]) ||
        (x < BUF - 1 && mask[y * BUF + x + 1]) ||
        (y > 0 && mask[(y - 1) * BUF + x]) ||
        (y < BUF - 1 && mask[(y + 1) * BUF + x]);
      if (!touch) continue;
      const onEdge = x === 0 || y === 0 || x === BUF - 1 || y === BUF - 1;
      if (onEdge) continue;
      if (carve && carve[y * BUF + x]) continue; // don't stamp teeth onto the road
      // every ~3rd position along the wall gets a merlon block
      if ((x + y) % 4 < 2) {
        px(b, x, y, PALETTE.stoneLight);
      } else {
        px(b, x, y, PALETTE.outline); // shadow gap between merlons
      }
    }
  }

  // centroid of city mass
  let mx = 0,
    my = 0,
    mc = 0;
  for (let y = 0; y < BUF; y++)
    for (let x = 0; x < BUF; x++)
      if (mask[y * BUF + x]) {
        mx += x;
        my += y;
        mc++;
      }
  if (mc === 0) return;
  mx /= mc;
  my /= mc;

  // buildings — cluster near centroid, avoid the wall band
  const hs = Math.round(BUF * 0.15);
  const n = full ? 5 : sides.length >= 2 ? 3 : 2;
  const placed: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ang = hash2(i, 2, salt + 12) * Math.PI * 2;
    const rad = (0.1 + hash2(i, 5, salt + 33) * 0.42) * BUF * (full ? 0.42 : 0.3);
    let hx = Math.round(mx + Math.cos(ang) * rad);
    let hy = Math.round(my + Math.sin(ang) * rad);
    hx = Math.max(hs, Math.min(BUF - hs, hx));
    hy = Math.max(hs, Math.min(BUF - hs, hy));
    if (!mask[hy * BUF + hx] || nearBoundary(mask, hx, hy, Math.round(wallW * 0.5))) {
      hx = Math.round(mx);
      hy = Math.round(my);
    }
    let ok = true;
    for (const [px2, py2] of placed)
      if (Math.abs(px2 - hx) < hs * 0.82 && Math.abs(py2 - hy) < hs * 0.82) ok = false;
    if (!ok) continue;
    if (!mask[hy * BUF + hx]) continue;
    // varied-size red-roofed houses (replaces the old featureless grey tower)
    const hw2 = Math.round(hs * (0.82 + hash2(i, 7, salt + 51) * 0.4));
    drawHouse(b, hx, hy, hw2, Math.round(hw2 * 0.92), salt + i * 17);
    placed.push([hx, hy]);
  }

  if (pennant) {
    const pxc = Math.max(9, Math.min(BUF - 9, Math.round(mx) + Math.round(BUF * 0.12)));
    const pyc = Math.max(9, Math.min(BUF - 9, Math.round(my) - Math.round(BUF * 0.06)));
    drawPennant(b, pxc, pyc);
  }
}

// ---------------------------------------------------------------------------
// CLOISTER — a little monastery: hall + bell tower + cross, walled garden.
// ---------------------------------------------------------------------------
function drawCloister(b: Buf, salt: number): void {
  const ctx = b.ctx;
  // low garden wall ring
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = PALETTE.chapelWallDark;
  ctx.lineWidth = 3;
  ctx.strokeRect(CX - 30, CY - 26, 60, 56);
  ctx.globalAlpha = 1;
  const w = 40,
    h = 34;
  const x = Math.round(CX - w / 2);
  const y = Math.round(CY - h / 2) + 3;
  const roofH = 15;
  const wallH = h - roofH;
  // shadow
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = PALETTE.grassDeep;
  ctx.beginPath();
  ctx.ellipse(CX, y + h, w * 0.55, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // walls
  rect(b, x, y + roofH, w, wallH, PALETTE.chapelWall);
  rect(b, x, y + roofH, 2, wallH, PALETTE.chapelWallDark);
  rect(b, x + w - 2, y + roofH, 2, wallH, PALETTE.chapelWallDark);
  // arched door + windows
  const dw = 8;
  rect(b, x + Math.round((w - dw) / 2), y + roofH + 5, dw, wallH - 5, PALETTE.chapelRoofDark);
  rect(b, x + 6, y + roofH + 5, 4, 5, PALETTE.window);
  rect(b, x + w - 10, y + roofH + 5, 4, 5, PALETTE.window);
  // red-tiled roof
  for (let ry = 0; ry < roofH; ry++) {
    const inset = Math.round((ry / roofH) * (w / 2 - 1));
    const col = ry <= 1 ? PALETTE.chapelRoof : ry >= roofH - 1 ? PALETTE.chapelRoofDark : PALETTE.chapelRoof;
    rect(b, x + inset, y + ry, w - inset * 2, 1, col);
    if (ry === Math.round(roofH * 0.5)) rect(b, x + inset, y + ry, w - inset * 2, 1, PALETTE.chapelRoofDark);
  }
  // bell tower + cross
  const tx = CX - 3;
  rect(b, tx, y - 10, 6, 12, PALETTE.chapelWall);
  rect(b, tx, y - 10, 6, 2, PALETTE.chapelRoof);
  rect(b, CX - 0.5, y - 15, 1.5, 6, PALETTE.cross);
  rect(b, CX - 2, y - 13, 5, 1.5, PALETTE.cross);
  outlineRect(b, x, y, w, h);
  void salt;
}

// ---------------------------------------------------------------------------
// MAIN RENDER
// ---------------------------------------------------------------------------
function renderToBuffer(def: TileDef, rot: number): HTMLCanvasElement {
  const c = makeCanvas(BUF, BUF);
  const ctx = c.getContext("2d")!;
  const b: Buf = { ctx };
  const salt = (def.id.charCodeAt(0) * 31 + (def.id.charCodeAt(1) || 0) * 7 + rot * 101) >>> 0;

  drawGrassBase(b, salt);

  const cities: { sides: number[]; pennant: boolean }[] = [];
  const roadSides: number[] = [];
  let hasCloister = false;
  for (const seg of def.segments) {
    const e = rotatedEdges(seg, rot);
    if (seg.kind === "city") cities.push({ sides: e, pennant: seg.pennant === true });
    else if (seg.kind === "road") roadSides.push(...e);
    else if (seg.kind === "cloister") hasCloister = true;
  }
  const riverSides: number[] = [];
  for (let k = 0; k < 4; k++) if (def.edges[k] === "river") riverSides.push(rotSide(k, rot));

  // order: water -> roads(+bridge) -> cities -> cloister. Fields stay clean
  // open grass (just the soft mottled texture) — no discrete trees/huts.
  if (riverSides.length) drawRiverSegment(b, riverSides, salt);
  if (roadSides.length) {
    drawRoadSegment(b, roadSides, salt);
    if (riverSides.length) drawBridgePlanks(b, roadSides, riverSides);
  }
  // road band (slightly widened) to carve out of any city so the city wall stops
  // at a clean grassy verge beside the road instead of painting over it.
  const roadCarve = roadSides.length ? dilate(buildRoadMask(roadSides), 2) : undefined;
  if (cities.length <= 1) {
    for (const city of cities) drawCitySegment(b, city.sides, city.pennant, salt, undefined, roadCarve);
  } else {
    // Two+ SEPARATE cities on one tile (e.g. a double-cap): give each pixel to
    // the nearest city, then carve a thin field seam between different owners so
    // the caps read as clearly separate walled cities instead of one blob.
    const masks = cities.map((c) => buildCityMask(c.sides));
    const owner = new Int8Array(BUF * BUF).fill(-1);
    for (let p = 0; p < BUF * BUF; p++) {
      const x = (p % BUF) + 0.5, y = ((p / BUF) | 0) + 0.5;
      let best = -1, bestD = Infinity;
      for (let ci = 0; ci < cities.length; ci++) {
        if (!masks[ci][p]) continue;
        let dmin = Infinity;
        for (const s of cities[ci].sides) {
          const [ex, ey] = endpoint(s);
          const dd = (x - ex) ** 2 + (y - ey) ** 2;
          if (dd < dmin) dmin = dd;
        }
        if (dmin < bestD) { bestD = dmin; best = ci; }
      }
      owner[p] = best;
    }
    // erode the border between different owners → a 2px field seam
    const seam = new Uint8Array(BUF * BUF);
    for (let y = 0; y < BUF; y++)
      for (let x = 0; x < BUF; x++) {
        const p = y * BUF + x;
        if (owner[p] < 0) continue;
        const nb = [p - 1, p + 1, p - BUF, p + BUF];
        for (const q of nb)
          if (q >= 0 && q < BUF * BUF && owner[q] >= 0 && owner[q] !== owner[p]) { seam[p] = 1; break; }
      }
    cities.forEach((c, ci) => {
      const m = new Uint8Array(BUF * BUF);
      for (let p = 0; p < BUF * BUF; p++) if (owner[p] === ci && !seam[p]) m[p] = 1;
      drawCitySegment(b, c.sides, c.pennant, salt, m, roadCarve);
    });
  }
  if (hasCloister) drawCloister(b, salt);

  // subtle vignette + soft tile frame
  ctx.strokeStyle = "rgba(40,28,14,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, BUF - 2, BUF - 2);

  return c;
}

function cacheKey(def: TileDef, rot: number): string {
  return `${def.id}:${rot}`;
}
function getBuffer(def: TileDef, rot: number): HTMLCanvasElement {
  const key = cacheKey(def, rot);
  const hit = tileCache.get(key);
  if (hit) return hit.canvas;
  const canvas = renderToBuffer(def, rot);
  tileCache.set(key, { canvas });
  return canvas;
}

// ---------------------------------------------------------------------------
// PUBLIC
// ---------------------------------------------------------------------------
export interface DrawTileOpts {
  ghost?: boolean;
  highlight?: boolean;
}

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
  ctx.imageSmoothingEnabled = true; // soft, painted downscale (not chunky)
  (ctx as any).imageSmoothingQuality = "high";

  if (opts?.ghost) ctx.globalAlpha = 0.55;
  ctx.drawImage(buf, 0, 0, BUF, BUF, Math.round(x), Math.round(y), size, size);
  if (opts?.ghost) ctx.globalAlpha = 1;

  if (opts?.highlight) {
    ctx.save();
    ctx.strokeStyle = PALETTE.highlightEdge;
    ctx.lineWidth = Math.max(2, Math.round(size * 0.03));
    const inset = ctx.lineWidth / 2;
    ctx.shadowColor = PALETTE.highlight;
    ctx.shadowBlur = size * 0.14;
    ctx.strokeRect(Math.round(x) + inset, Math.round(y) + inset, size - ctx.lineWidth, size - ctx.lineWidth);
    ctx.restore();
  }
  ctx.imageSmoothingEnabled = prevSmoothing;
  void shade;
}

export function prewarmTile(def: TileDef, rotation: Rotation): void {
  getBuffer(def, rotation);
}
export const TILE_BUFFER_RES = BUF;
