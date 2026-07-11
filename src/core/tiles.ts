// ============================================================================
// T3dassonne — Canonical base-game tile data (72 tiles, types A–X).
// Segments are defined in the UNROTATED frame (rotation 0).
// city/road segment `edges` = Side indices (0=N,1=E,2=S,3=W).
// field segment `edges`     = HalfEdge indices (0..7, see types.ts).
// NOTE: engine (src/engine) owns final verification of farm topology; keep the
// exported shape (TileDef/Segment) stable for render/ai/ui consumers.
// ============================================================================

import type { EdgeType, Segment, TileDef } from "./types";

// side & half-edge midpoints (0..1) used to auto-place meeple spots
const SIDE_MID: Record<number, [number, number]> = {
  0: [0.5, 0.16],
  1: [0.84, 0.5],
  2: [0.5, 0.84],
  3: [0.16, 0.5],
};
const HALF_MID: Record<number, [number, number]> = {
  0: [0.32, 0.13],
  1: [0.68, 0.13],
  2: [0.87, 0.32],
  3: [0.87, 0.68],
  4: [0.68, 0.87],
  5: [0.32, 0.87],
  6: [0.13, 0.68],
  7: [0.13, 0.32],
};

type RawSeg =
  | { k: "city"; sides: number[]; pennant?: boolean }
  | { k: "road"; sides: number[] }
  | { k: "cloister" }
  | { k: "field"; nodes: number[]; adjCity?: number[] };

interface RawTile {
  id: string;
  count: number;
  edges: [EdgeType, EdgeType, EdgeType, EdgeType];
  segs: RawSeg[];
}

function centroid(pts: [number, number][], pull = 0.22): { x: number; y: number } {
  if (pts.length === 0) return { x: 0.5, y: 0.5 };
  let sx = 0,
    sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  let x = sx / pts.length;
  let y = sy / pts.length;
  // pull slightly toward center so meeples sit inside the tile art
  x = x + (0.5 - x) * pull;
  y = y + (0.5 - y) * pull;
  return { x, y };
}

function buildSegments(raw: RawTile): Segment[] {
  return raw.segs.map((rs, i): Segment => {
    if (rs.k === "cloister") {
      return { index: i, kind: "cloister", edges: [], spot: { x: 0.5, y: 0.5 } };
    }
    if (rs.k === "field") {
      const pts = rs.nodes.map((n) => HALF_MID[n]);
      return {
        index: i,
        kind: "field",
        edges: rs.nodes.slice(),
        spot: centroid(pts, 0.3),
        adjacentCitySegments: rs.adjCity ? rs.adjCity.slice() : [],
      };
    }
    // city / road
    const pts = rs.sides.map((s) => SIDE_MID[s]);
    return {
      index: i,
      kind: rs.k,
      edges: rs.sides.slice(),
      pennant: rs.k === "city" ? (rs as any).pennant === true : undefined,
      spot: centroid(pts, rs.k === "road" ? 0.15 : 0.25),
    };
  });
}

// F=field, R=road, C=city
const RAW: RawTile[] = [
  // A: cloister + road to S
  { id: "A", count: 2, edges: ["field", "field", "road", "field"],
    segs: [{ k: "cloister" }, { k: "road", sides: [2] }, { k: "field", nodes: [0, 1, 2, 3, 4, 5, 6, 7] }] },
  // B: cloister
  { id: "B", count: 4, edges: ["field", "field", "field", "field"],
    segs: [{ k: "cloister" }, { k: "field", nodes: [0, 1, 2, 3, 4, 5, 6, 7] }] },
  // C: city all sides, pennant
  { id: "C", count: 1, edges: ["city", "city", "city", "city"],
    segs: [{ k: "city", sides: [0, 1, 2, 3], pennant: true }] },
  // D: start tile — city E, straight road N-S
  { id: "D", count: 4, edges: ["road", "city", "road", "field"],
    segs: [
      { k: "city", sides: [1] },
      { k: "road", sides: [0, 2] },
      { k: "field", nodes: [0, 5, 6, 7] },
      { k: "field", nodes: [1, 4], adjCity: [0] },
    ] },
  // E: city N
  { id: "E", count: 5, edges: ["city", "field", "field", "field"],
    segs: [{ k: "city", sides: [0] }, { k: "field", nodes: [2, 3, 4, 5, 6, 7], adjCity: [0] }] },
  // F: city E-W connected, pennant
  { id: "F", count: 2, edges: ["field", "city", "field", "city"],
    segs: [
      { k: "city", sides: [1, 3], pennant: true },
      { k: "field", nodes: [0, 1], adjCity: [0] },
      { k: "field", nodes: [4, 5], adjCity: [0] },
    ] },
  // G: city N-S connected (drawn as opposite sides)
  { id: "G", count: 1, edges: ["city", "field", "city", "field"],
    segs: [
      { k: "city", sides: [0, 2] },
      { k: "field", nodes: [2, 3], adjCity: [0] },
      { k: "field", nodes: [6, 7], adjCity: [0] },
    ] },
  // H: two separate cities E & W, field between
  { id: "H", count: 3, edges: ["field", "city", "field", "city"],
    segs: [
      { k: "city", sides: [1] },
      { k: "city", sides: [3] },
      { k: "field", nodes: [0, 1, 4, 5], adjCity: [0, 1] },
    ] },
  // I: two separate cities on adjacent sides E & S
  { id: "I", count: 2, edges: ["field", "city", "city", "field"],
    segs: [
      { k: "city", sides: [1] },
      { k: "city", sides: [2] },
      { k: "field", nodes: [0, 1, 6, 7], adjCity: [0, 1] },
    ] },
  // J: city N, road turn E-S
  { id: "J", count: 3, edges: ["city", "road", "road", "field"],
    segs: [
      { k: "city", sides: [0] },
      { k: "road", sides: [1, 2] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [2, 5, 6, 7], adjCity: [0] },
    ] },
  // K: city N, road turn W-S
  { id: "K", count: 3, edges: ["city", "field", "road", "road"],
    segs: [
      { k: "city", sides: [0] },
      { k: "road", sides: [2, 3] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [2, 3, 4, 7], adjCity: [0] },
    ] },
  // L: city N, road T-junction E-S-W
  { id: "L", count: 3, edges: ["city", "road", "road", "road"],
    segs: [
      { k: "city", sides: [0] },
      { k: "road", sides: [1] },
      { k: "road", sides: [2] },
      { k: "road", sides: [3] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [2, 7], adjCity: [0] },
    ] },
  // M: city N-W connected, pennant
  { id: "M", count: 2, edges: ["city", "field", "field", "city"],
    segs: [
      { k: "city", sides: [0, 3], pennant: true },
      { k: "field", nodes: [2, 3, 4, 5], adjCity: [0] },
    ] },
  // N: city N-W connected
  { id: "N", count: 3, edges: ["city", "field", "field", "city"],
    segs: [
      { k: "city", sides: [0, 3] },
      { k: "field", nodes: [2, 3, 4, 5], adjCity: [0] },
    ] },
  // O: city N-W connected + road turn E-S, pennant
  { id: "O", count: 2, edges: ["city", "road", "road", "city"],
    segs: [
      { k: "city", sides: [0, 3], pennant: true },
      { k: "road", sides: [1, 2] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [2, 5], adjCity: [0] },
    ] },
  // P: city N-W connected + road turn E-S
  { id: "P", count: 3, edges: ["city", "road", "road", "city"],
    segs: [
      { k: "city", sides: [0, 3] },
      { k: "road", sides: [1, 2] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [2, 5], adjCity: [0] },
    ] },
  // Q: city N-E-W connected, pennant
  { id: "Q", count: 1, edges: ["city", "city", "field", "city"],
    segs: [
      { k: "city", sides: [0, 1, 3], pennant: true },
      { k: "field", nodes: [4, 5], adjCity: [0] },
    ] },
  // R: city N-E-W connected
  { id: "R", count: 3, edges: ["city", "city", "field", "city"],
    segs: [
      { k: "city", sides: [0, 1, 3] },
      { k: "field", nodes: [4, 5], adjCity: [0] },
    ] },
  // S: city N-E-W connected + road S, pennant
  { id: "S", count: 2, edges: ["city", "city", "road", "city"],
    segs: [
      { k: "city", sides: [0, 1, 3], pennant: true },
      { k: "road", sides: [2] },
      { k: "field", nodes: [4], adjCity: [0] },
      { k: "field", nodes: [5], adjCity: [0] },
    ] },
  // T: city N-E-W connected + road S
  { id: "T", count: 1, edges: ["city", "city", "road", "city"],
    segs: [
      { k: "city", sides: [0, 1, 3] },
      { k: "road", sides: [2] },
      { k: "field", nodes: [4], adjCity: [0] },
      { k: "field", nodes: [5], adjCity: [0] },
    ] },
  // U: straight road N-S
  { id: "U", count: 8, edges: ["road", "field", "road", "field"],
    segs: [
      { k: "road", sides: [0, 2] },
      { k: "field", nodes: [0, 5, 6, 7] },
      { k: "field", nodes: [1, 2, 3, 4] },
    ] },
  // V: road turn S-W
  { id: "V", count: 9, edges: ["field", "field", "road", "road"],
    segs: [
      { k: "road", sides: [2, 3] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [0, 1, 2, 3, 4, 7] },
    ] },
  // W: road T-junction E-S-W
  { id: "W", count: 4, edges: ["field", "road", "road", "road"],
    segs: [
      { k: "road", sides: [1] },
      { k: "road", sides: [2] },
      { k: "road", sides: [3] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [0, 1, 2, 7] },
    ] },
  // X: crossroads (four roads)
  { id: "X", count: 1, edges: ["road", "road", "road", "road"],
    segs: [
      { k: "road", sides: [0] },
      { k: "road", sides: [1] },
      { k: "road", sides: [2] },
      { k: "road", sides: [3] },
      { k: "field", nodes: [1, 2] },
      { k: "field", nodes: [3, 4] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [7, 0] },
    ] },
];

// ============================================================================
// The River (base expansion) — 12 tiles: 1 spring/source, 1 lake, and 10 middle
// tiles (6 straights + 4 curves, some carrying a road or a small city). Water is
// a 4th edge type ("river") used only for edge-matching + rendering — it is NOT
// a scoreable segment. Field nodes flank a river exactly like a road (a bank on
// each side), so every non-city half-edge belongs to a farm segment.
// (The River II fork + volcano tiles are not part of this base set.)
// ============================================================================
const RIVER_RAW: RawTile[] = [
  // source / spring: river out the south edge; field wraps fully around the pond
  { id: "RSRC", count: 1, edges: ["field", "field", "river", "field"],
    segs: [{ k: "field", nodes: [0, 1, 2, 3, 4, 5, 6, 7] }] },
  // lake / end: river in from the north edge; field wraps fully around
  { id: "RLAK", count: 1, edges: ["river", "field", "field", "field"],
    segs: [{ k: "field", nodes: [0, 1, 2, 3, 4, 5, 6, 7] }] },
  // straight river N-S: a full bank on each side (like a straight road)
  { id: "RSTR", count: 4, edges: ["river", "field", "river", "field"],
    segs: [{ k: "field", nodes: [0, 5, 6, 7] }, { k: "field", nodes: [1, 2, 3, 4] }] },
  // curve river N-E: large outer bank + small inner corner between the arms
  { id: "RCRV", count: 3, edges: ["river", "river", "field", "field"],
    segs: [{ k: "field", nodes: [0, 3, 4, 5, 6, 7] }, { k: "field", nodes: [1, 2] }] },
  // straight river N-S with a road crossing E-W (bridge) → 4 field quadrants
  { id: "RSTRD", count: 1, edges: ["river", "road", "river", "road"],
    segs: [
      { k: "road", sides: [1, 3] },
      { k: "field", nodes: [0, 7] }, { k: "field", nodes: [1, 2] },
      { k: "field", nodes: [3, 4] }, { k: "field", nodes: [5, 6] },
    ] },
  // curve river N-E with a road turn S-W: inner-NE, inner-SW elbow, outer band
  { id: "RCRVD", count: 1, edges: ["river", "river", "road", "road"],
    segs: [
      { k: "road", sides: [2, 3] },
      { k: "field", nodes: [1, 2] },
      { k: "field", nodes: [5, 6] },
      { k: "field", nodes: [0, 3, 4, 7] },
    ] },
  // straight river N-S with a city on the east edge: west bank + east strip
  { id: "RSTRC", count: 1, edges: ["river", "city", "river", "field"],
    segs: [
      { k: "city", sides: [1] },
      { k: "field", nodes: [0, 5, 6, 7] },
      { k: "field", nodes: [1, 4], adjCity: [0] },
    ] },
];

export const TILE_DEFS: Record<string, TileDef> = {};
for (const raw of [...RAW, ...RIVER_RAW]) {
  TILE_DEFS[raw.id] = {
    id: raw.id,
    count: raw.count,
    edges: raw.edges,
    segments: buildSegments(raw),
  };
}

export const RIVER_SOURCE_ID = "RSRC";
export const RIVER_LAKE_ID = "RLAK";

/** Middle river tiles (everything except the source & lake), expanded by count. */
export function buildRiverMiddles(): string[] {
  const out: string[] = [];
  for (const raw of RIVER_RAW) {
    if (raw.id === RIVER_SOURCE_ID || raw.id === RIVER_LAKE_ID) continue;
    for (let i = 0; i < raw.count; i++) out.push(raw.id);
  }
  return out;
}

/** The start tile placed at (0,0) before the game begins. */
export const START_TILE_ID = "D";

/** Build the shuffled-in deck (all ids expanded by count, minus one start D). */
export function buildDeck(): string[] {
  const deck: string[] = [];
  for (const raw of RAW) {
    let n = raw.count;
    if (raw.id === START_TILE_ID) n -= 1; // one D is the start tile
    for (let i = 0; i < n; i++) deck.push(raw.id);
  }
  return deck;
}

/** Total tiles including the start tile (should be 72 for the base game). */
export const TOTAL_TILES = RAW.reduce((s, r) => s + r.count, 0);
