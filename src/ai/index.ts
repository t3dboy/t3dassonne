// ============================================================================
// T3dassonne — AI opponent (src/ai).
//
// Decoupled from the engine implementation: we import TYPES ONLY from
// ../core/types and receive the live `engine: Engine` object as a parameter.
// We never import from ../engine (it is built in parallel) and never mutate
// the caller's GameState — all lookahead runs on a deep clone.
//
// The engine module additionally exports `cloneState(g)`. Since that is not on
// the `Engine` interface, we detect it at runtime on the engine object (some
// engines attach it); otherwise we fall back to a local structural deep clone
// that mirrors the GameState shape. Either way lookahead is side-effect free.
// ============================================================================

import type {
  Engine,
  GameState,
  LegalPlacement,
  LegalMeeple,
  Player,
  PlacedTile,
  Segment,
  TileDef,
  FeatureKind,
  Rotation,
  Difficulty,
} from "../core/types";

export type { Difficulty } from "../core/types";

export interface AiTurn {
  placement: LegalPlacement;
  /** unrotated segment index, or -1 for "place no meeple". */
  meepleSegmentIndex: number;
}

// ---- Tuning knobs per difficulty ------------------------------------------

interface Tuning {
  /** how many top pre-scored placements to deeply simulate. */
  candidateCap: number;
  /** multiplier on "deny opponent" penalties. */
  denyWeight: number;
  /** multiplier on speculative (unfinished) feature value. */
  speculativeWeight: number;
  /** keep at least this many meeples in reserve before speculative claims. */
  reserve: number;
  /** if true, mostly-random legal placement + rare meeple (easy). */
  random: boolean;
  /** willingness to place farmers (0..1). */
  farmAppetite: number;
  /** multiplier on city-meeple value (aggressive leans hard into cities). */
  cityBias: number;
  /** >0 turns the "avoid helping opponents" term into a "contest them" reward:
   *  seek placements that build into / border the human's claimed features to
   *  set up shared or stolen cities. Only aggressive uses this. */
  aggression: number;
};

const TUNING: Record<Difficulty, Tuning> = {
  easy: {
    candidateCap: 6,
    denyWeight: 0,
    speculativeWeight: 0.35,
    reserve: 3,
    random: true,
    farmAppetite: 0.1,
    cityBias: 1.1,
    aggression: 0,
  },
  normal: {
    candidateCap: 12,
    denyWeight: 0.6,
    speculativeWeight: 0.8,
    reserve: 2,
    random: false,
    farmAppetite: 0.4,
    cityBias: 1.1,
    aggression: 0,
  },
  hard: {
    candidateCap: 20,
    denyWeight: 1.0,
    speculativeWeight: 1.0,
    reserve: 1,
    random: false,
    farmAppetite: 0.7,
    cityBias: 1.1,
    aggression: 0,
  },
  // Aggressive: strong search, spends meeples freely, barely farms, and heavily
  // rewards contesting the human — building into their cities to share/steal.
  aggressive: {
    candidateCap: 22,
    denyWeight: 1.0,
    speculativeWeight: 1.0,
    reserve: 0,
    random: false,
    farmAppetite: 0.15,
    cityBias: 1.9,
    aggression: 1.6,
  },
};

// ---- Deterministic pseudo-random (no Math.random) -------------------------

/** Reproducible hash → [0,1). Seeded from turn + candidate index. */
function prand(seed: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}

// ---- State cloning (side-effect-free lookahead) ---------------------------

type EngineWithClone = Engine & { cloneState?: (g: GameState) => GameState };

/** Deep clone via the engine's helper if attached, else a local fallback. */
function clone(engine: Engine, g: GameState): GameState {
  const withClone = engine as EngineWithClone;
  if (typeof withClone.cloneState === "function") {
    return withClone.cloneState(g);
  }
  return localClone(g);
}

/** Structural deep clone matching the GameState shape from types.ts. */
function localClone(g: GameState): GameState {
  const board = new Map<string, PlacedTile>();
  for (const [k, pt] of g.board) {
    board.set(k, {
      def: pt.def, // TileDef is immutable canonical data — shared by reference
      x: pt.x,
      y: pt.y,
      rotation: pt.rotation,
      meeple: pt.meeple ? { ...pt.meeple } : undefined,
    });
  }
  return {
    players: g.players.map((p) => ({ ...p })),
    current: g.current,
    board,
    deck: g.deck.slice(),
    drawn: g.drawn,
    drawnRotation: g.drawnRotation,
    phase: g.phase,
    turn: g.turn,
    passAndPlay: g.passAndPlay,
  };
}

// ---- Feature value model --------------------------------------------------

// Rough per-tile point values used when we can't fully evaluate a feature.
const CITY_TILE_VALUE = 2;
const ROAD_TILE_VALUE = 1;
const PENNANT_VALUE = 2;
const CLOISTER_BASE = 1;

/** Segment for the drawn tile by UNROTATED index. */
function segOf(def: TileDef, idx: number): Segment | undefined {
  return def.segments[idx];
}

/**
 * Count tiles currently forming the connected feature that a placed meeple on
 * `tile` / `segmentIndex` belongs to, plus whether it is already complete.
 * This is a light-weight flood over the board using edge adjacency; it exists
 * so the AI can estimate feature size WITHOUT relying on engine internals.
 *
 * Returns { tiles, open, pennants, complete } where `open` counts unmatched
 * open edges (0 ⇒ complete for city/road).
 */
function surveyFeature(
  g: GameState,
  startX: number,
  startY: number,
  startRotation: Rotation,
  seg: Segment,
): { tiles: number; open: number; pennants: number; complete: boolean } {
  const kind = seg.kind;
  if (kind === "cloister") {
    // cloister value = 1 + number of occupied neighbours (of 8 surrounding).
    let filled = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (g.board.has(`${startX + dx},${startY + dy}`)) filled++;
      }
    }
    return { tiles: 1, open: 8 - filled, pennants: 0, complete: filled === 8 };
  }
  if (kind === "field") {
    // fields are not "completed"; handled separately by farm scoring estimate.
    return { tiles: 1, open: 0, pennants: 0, complete: false };
  }

  // city / road: flood across the board following matching edges.
  // Node identity = `${x},${y}#${sideIndexRotated}` grouped per tile-segment.
  const visitedTiles = new Set<string>();
  let openEdges = 0;
  let pennants = 0;

  // A frontier item is (x,y, rotatedSide) we need to expand from.
  type Frontier = { x: number; y: number; side: number };
  const frontier: Frontier[] = [];

  const pushTileSegment = (
    x: number,
    y: number,
    def: TileDef,
    rotation: Rotation,
    localSeg: Segment,
  ) => {
    const key = `${x},${y}#${localSeg.index}`;
    if (visitedTiles.has(key)) return;
    visitedTiles.add(key);
    if (localSeg.kind === "city" && localSeg.pennant) pennants++;
    for (const s of localSeg.edges) {
      const rs = ((s + rotation) % 4) as number;
      frontier.push({ x, y, side: rs });
    }
  };

  // seed with the hypothetical placement's segment (not yet on the board).
  const startDef = g.drawn as TileDef;
  pushTileSegment(startX, startY, startDef, startRotation, seg);

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const OPP = [2, 3, 0, 1];

  const localSegForRotatedSide = (
    pt: PlacedTile,
    wantKind: FeatureKind,
    rotatedSide: number,
  ): Segment | undefined => {
    for (const s of pt.def.segments) {
      if (s.kind !== wantKind) continue;
      for (const e of s.edges) {
        if (((e + pt.rotation) % 4) === rotatedSide) return s;
      }
    }
    return undefined;
  };

  let guard = 0;
  while (frontier.length && guard++ < 4000) {
    const f = frontier.pop()!;
    const nx = f.x + DX[f.side];
    const ny = f.y + DY[f.side];
    const neighbourKey = `${nx},${ny}`;
    const neighbour = g.board.get(neighbourKey);
    if (!neighbour) {
      // open edge — but skip the seed tile's own edges pointing at itself.
      openEdges++;
      continue;
    }
    const inSide = OPP[f.side];
    const ns = localSegForRotatedSide(neighbour, kind, inSide);
    if (!ns) {
      // neighbour exists but no matching feature segment (shouldn't happen for
      // legal boards) — treat as closed.
      continue;
    }
    pushTileSegment(nx, ny, neighbour.def, neighbour.rotation, ns);
  }

  return {
    tiles: visitedTiles.size,
    open: openEdges,
    pennants,
    complete: openEdges === 0,
  };
}

/**
 * Does `seg` on the hypothetical tile connect to a feature that ALREADY has a
 * meeple? Returns the set of owning playerIds (so we can detect "I already own
 * this" and "opponent owns this").
 */
function featureOwners(
  g: GameState,
  startX: number,
  startY: number,
  startRotation: Rotation,
  seg: Segment,
): number[] {
  const owners: number[] = [];
  if (seg.kind === "cloister") return owners; // a cloister is its own tile only
  if (seg.kind === "field") {
    // Fields flood over half-edges; owner detection for farms is expensive and
    // rarely needed for the greedy heuristic — approximate as "unclaimed".
    return owners;
  }

  const visited = new Set<string>();
  type Frontier = { x: number; y: number; side: number };
  const frontier: Frontier[] = [];
  const kind = seg.kind;

  const startDef = g.drawn as TileDef;
  const seed = (x: number, y: number, s: Segment, rotation: Rotation, pt?: PlacedTile) => {
    const key = `${x},${y}#${s.index}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (pt?.meeple && pt.meeple.segmentIndex === s.index) {
      owners.push(pt.meeple.playerId);
    }
    for (const e of s.edges) frontier.push({ x, y, side: ((e + rotation) % 4) });
  };
  seed(startX, startY, seg, startRotation, undefined);

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const OPP = [2, 3, 0, 1];
  const localSegForRotatedSide = (pt: PlacedTile, rotatedSide: number): Segment | undefined => {
    for (const s of pt.def.segments) {
      if (s.kind !== kind) continue;
      for (const e of s.edges) if (((e + pt.rotation) % 4) === rotatedSide) return s;
    }
    return undefined;
  };

  let guard = 0;
  while (frontier.length && guard++ < 4000) {
    const f = frontier.pop()!;
    const nx = f.x + DX[f.side];
    const ny = f.y + DY[f.side];
    const nb = g.board.get(`${nx},${ny}`);
    if (!nb) continue;
    const ns = localSegForRotatedSide(nb, OPP[f.side]);
    if (!ns) continue;
    seed(nx, ny, ns, nb.rotation, nb);
  }
  return owners;
}

// ---- Field / farm survey --------------------------------------------------
// Farms are the one feature the greedy heuristic used to badly misjudge: their
// payoff is 3 pts per DISTINCT COMPLETED city the whole connected field touches,
// only at game end. To value them properly we must flood the entire field
// component (over half-edges, exactly like the engine) and tally the distinct
// cities it borders, weighting completed cities fully and open ones by their
// chance of finishing. Constants below mirror src/engine (kept local to honour
// the ai↔engine decoupling).

const FDX = [0, 1, 0, -1];
const FDY = [-1, 0, 1, 0];
const FOPP = [2, 3, 0, 1];
// world-node pairing across a border, per world side (see engine FIELD_BORDER).
const FIELD_BORDER: Record<number, [number, number][]> = {
  0: [[0, 5], [1, 4]], // N
  1: [[2, 7], [3, 6]], // E
  2: [[4, 1], [5, 0]], // S
  3: [[6, 3], [7, 2]], // W
};
/** unrotated half-edge node → world node. */
const rotNodeW = (node: number, rotation: number): number => (((node + 2 * rotation) % 8) + 8) % 8;
/** field segment index on a placed tile owning a given WORLD half-edge node. */
function fieldSegWithWorldNode(pt: PlacedTile, worldNode: number): number {
  for (const s of pt.def.segments) {
    if (s.kind !== "field") continue;
    for (const n of s.edges) if (rotNodeW(n, pt.rotation) === worldNode) return s.index;
  }
  return -1;
}

/** Flood the CITY component containing (x,y,segIdx) on the board; return a stable
 *  identity key (min node string) plus whether it is already closed (complete). */
function cityComponent(g: GameState, x: number, y: number, segIdx: number): { key: string; complete: boolean } | null {
  const start = g.board.get(`${x},${y}`);
  if (!start) return null;
  const visited = new Set<string>();
  const stack: [number, number, number][] = [[x, y, segIdx]];
  let complete = true;
  let key = `${x},${y}#${segIdx}`;
  let guard = 0;
  while (stack.length && guard++ < 4000) {
    const [cx, cy, si] = stack.pop()!;
    const k = `${cx},${cy}#${si}`;
    if (visited.has(k)) continue;
    visited.add(k);
    if (k < key) key = k;
    const pt = g.board.get(`${cx},${cy}`);
    if (!pt) continue;
    const s = pt.def.segments[si];
    if (!s || s.kind !== "city") continue;
    for (const unrotSide of s.edges) {
      const ws = (unrotSide + pt.rotation) % 4;
      const nx = cx + FDX[ws], ny = cy + FDY[ws];
      const nb = g.board.get(`${nx},${ny}`);
      if (!nb) { complete = false; continue; } // an open edge → city not closed
      const inSide = FOPP[ws];
      let found = -1;
      for (const ns of nb.def.segments) {
        if (ns.kind !== "city") continue;
        if (ns.edges.some((e) => ((e + nb.rotation) % 4) === inSide)) { found = ns.index; break; }
      }
      if (found >= 0) stack.push([nx, ny, found]);
    }
  }
  return { key, complete };
}

/** Flood the CITY component containing (x,y,segIdx) and tally who holds it: how
 *  many followers belong to `aiId` vs everyone else, plus size/pennants/closed.
 *  Used by the aggressive AI to judge a merge — share (tie), steal (majority),
 *  or gift (we have no stake). Assumes the tile is already on the board. */
function analyzeCity(
  g: GameState, x: number, y: number, segIdx: number, aiId: number,
): { key: string; complete: boolean; tiles: number; pennants: number; aiCount: number; oppCount: number } | null {
  if (!g.board.get(`${x},${y}`)) return null;
  const visited = new Set<string>();
  const countedTiles = new Set<string>();
  const stack: [number, number, number][] = [[x, y, segIdx]];
  let complete = true, tiles = 0, pennants = 0, aiCount = 0, oppCount = 0;
  let key = `${x},${y}#${segIdx}`;
  let guard = 0;
  while (stack.length && guard++ < 4000) {
    const [cx, cy, si] = stack.pop()!;
    const k = `${cx},${cy}#${si}`;
    if (visited.has(k)) continue;
    visited.add(k);
    if (k < key) key = k;
    const pt = g.board.get(`${cx},${cy}`);
    if (!pt) continue;
    const s = pt.def.segments[si];
    if (!s || s.kind !== "city") continue;
    if (!countedTiles.has(`${cx},${cy}`)) { countedTiles.add(`${cx},${cy}`); tiles++; }
    if (s.pennant) pennants++;
    if (pt.meeple && pt.meeple.segmentIndex === si) {
      if (pt.meeple.playerId === aiId) aiCount++; else oppCount++;
    }
    for (const unrotSide of s.edges) {
      const ws = (unrotSide + pt.rotation) % 4;
      const nx = cx + FDX[ws], ny = cy + FDY[ws];
      const nb = g.board.get(`${nx},${ny}`);
      if (!nb) { complete = false; continue; }
      const inSide = FOPP[ws];
      let found = -1;
      for (const ns of nb.def.segments) {
        if (ns.kind !== "city") continue;
        if (ns.edges.some((e) => ((e + nb.rotation) % 4) === inSide)) { found = ns.index; break; }
      }
      if (found >= 0) stack.push([nx, ny, found]);
    }
  }
  return { key, complete, tiles, pennants, aiCount, oppCount };
}

/** Flood the FIELD component containing (x,y,startSeg) and tally the distinct
 *  cities it borders, split into completed vs still-open. The start tile is
 *  assumed already on the board (true in every caller). */
function surveyField(
  g: GameState,
  x: number,
  y: number,
  startSeg: number,
): { fieldTiles: number; completeCities: number; openCities: number } {
  const start = g.board.get(`${x},${y}`);
  if (!start) return { fieldTiles: 0, completeCities: 0, openCities: 0 };
  const visited = new Set<string>();
  const fieldTiles = new Set<string>();
  const cities = new Map<string, boolean>(); // city key → complete
  const stack: [number, number, number][] = [[x, y, startSeg]];
  let guard = 0;
  while (stack.length && guard++ < 6000) {
    const [cx, cy, si] = stack.pop()!;
    const k = `${cx},${cy}#${si}`;
    if (visited.has(k)) continue;
    visited.add(k);
    const pt = g.board.get(`${cx},${cy}`);
    if (!pt) continue;
    const s = pt.def.segments[si];
    if (!s || s.kind !== "field") continue;
    fieldTiles.add(`${cx},${cy}`);
    // distinct cities this field segment borders
    for (const ci of s.adjacentCitySegments ?? []) {
      const comp = cityComponent(g, cx, cy, ci);
      if (comp && !cities.has(comp.key)) cities.set(comp.key, comp.complete);
    }
    // flood field neighbours across shared half-edges
    for (const n of s.edges) {
      const wn = rotNodeW(n, pt.rotation);
      const ws = Math.floor(wn / 2); // node 0-1→N, 2-3→E, 4-5→S, 6-7→W
      const nx = cx + FDX[ws], ny = cy + FDY[ws];
      const nb = g.board.get(`${nx},${ny}`);
      if (!nb) continue;
      const pair = FIELD_BORDER[ws].find((p) => p[0] === wn);
      if (!pair) continue;
      const nseg = fieldSegWithWorldNode(nb, pair[1]);
      if (nseg >= 0) stack.push([nx, ny, nseg]);
    }
  }
  let completeCities = 0, openCities = 0;
  for (const done of cities.values()) done ? completeCities++ : openCities++;
  return { fieldTiles: fieldTiles.size, completeCities, openCities };
}

// ---- Meeple evaluation ----------------------------------------------------

/**
 * Estimate the value (to the AI player) of placing a meeple on `seg` of the
 * just-placed tile at (x,y,rotation). Negative or tiny values mean "don't".
 */
function meepleValue(
  g: GameState,
  aiPlayer: Player,
  x: number,
  y: number,
  rotation: Rotation,
  seg: Segment,
  t: Tuning,
): number {
  const owners = featureOwners(g, x, y, rotation, seg);
  const meeplesLeft = aiPlayer.meeplesLeft;

  // Never contest a feature we already control (waste), and don't join a
  // feature an opponent already has a meeple on (they'd win majority or share).
  if (owners.includes(aiPlayer.id)) return -1000;
  if (owners.length > 0) return -1000; // occupied by someone → cannot legally place anyway

  const survey = surveyFeature(g, x, y, rotation, seg);

  if (seg.kind === "cloister") {
    const neighboursNow = 8 - survey.open; // occupied of the 8 surrounding tiles
    const nowScore = CLOISTER_BASE + neighboursNow;
    if (survey.complete) return nowScore; // instant, guaranteed
    // speculative: cloisters complete reliably in the mid-game — assume ~2.5
    // of the remaining neighbour slots eventually fill.
    const expected = CLOISTER_BASE + Math.min(8, neighboursNow + 2.5);
    return expected * t.speculativeWeight;
  }

  if (seg.kind === "field") {
    // Value the WHOLE connected field: 3 pts per distinct city it touches, with
    // completed cities counted in full and still-open ones discounted (they may
    // yet close). This lets a fat multi-city farm read as the big play it is,
    // while a lone field beside one unfinished city stays cheap.
    const fs = surveyField(g, x, y, seg.index);
    const potential = fs.completeCities * 3 + fs.openCities * 3 * 0.45;
    if (potential <= 0) return -50; // borders no city → scores nothing, ever
    // Reserve discipline: a farmer is locked away until the game ends, so only
    // spend one from the reserve when the payoff is genuinely large.
    if (meeplesLeft <= t.reserve && potential < 6) return -50;
    let val = potential * t.farmAppetite;
    if (fs.completeCities >= 2) val *= 1.3; // a big secured farm competes with cities
    return val;
  }

  // city or road.
  const perTile = seg.kind === "city" ? CITY_TILE_VALUE : ROAD_TILE_VALUE;
  const solidPoints = survey.tiles * perTile + survey.pennants * PENNANT_VALUE;

  if (survey.complete) {
    // completing our own feature right now — full, guaranteed points.
    return seg.kind === "city" ? solidPoints * t.cityBias : solidPoints;
  }

  // Speculative claim of an unclaimed feature we can plausibly finish.
  // Value grows with current size but is discounted by how "open" it is
  // (more open edges ⇒ harder/slower to finish).
  const finishability = 1 / (1 + survey.open * 0.6);
  let val = solidPoints * finishability * t.speculativeWeight;

  // Reserve discipline: with few meeples, only claim clearly-good things.
  if (meeplesLeft <= t.reserve) {
    val *= 0.35;
    if (val < 2) return val - 3; // discourage low-value locks when short
  }

  // Cities are worth more per tile; nudge the AI toward them.
  if (seg.kind === "city") val *= t.cityBias;

  return val;
}

/**
 * Best meeple option for the tile that has just been placed on `g` (which is
 * already in the placeMeeple phase). Returns unrotated segmentIndex or -1.
 */
export function bestMeeple(
  engine: Engine,
  gAfterPlace: GameState,
  difficulty: Difficulty = "normal",
): number {
  const t = TUNING[difficulty];
  const aiPlayer = gAfterPlace.players[gAfterPlace.current];
  const legal = engine.legalMeeples(gAfterPlace);
  if (!legal.length) return -1;

  // locate the just-placed tile (the one carrying no meeple that matches the
  // drawn def at its position). We rely on engine having recorded x/y in the
  // phase; simplest robust approach: the placement is the most recently added
  // board tile without a meeple. We find it by scanning for the drawn def.
  const placed = findJustPlaced(gAfterPlace);
  if (!placed) return -1;

  // easy: usually skip; rarely place a random legal meeple.
  if (t.random) {
    const roll = prand(gAfterPlace.turn * 31 + 7);
    if (roll > 0.4) return -1; // 60% skip
    const pick = legal[Math.floor(prand(gAfterPlace.turn * 17 + 3) * legal.length)];
    return pick ? pick.segmentIndex : -1;
  }

  let best = -1;
  let bestVal = 0.5; // require a positive threshold to bother placing at all
  for (let i = 0; i < legal.length; i++) {
    const lm = legal[i];
    const seg = segOf(placed.def, lm.segmentIndex);
    if (!seg) continue;
    let v = meepleValue(gAfterPlace, aiPlayer, placed.x, placed.y, placed.rotation, seg, t);
    // deterministic tie-break jitter
    v += prand(gAfterPlace.turn * 101 + i) * 0.01;
    if (v > bestVal) {
      bestVal = v;
      best = lm.segmentIndex;
    }
  }
  return best;
}

/** Find the tile just placed (placeMeeple phase): matches drawn def, no meeple. */
function findJustPlaced(g: GameState): PlacedTile | undefined {
  const def = g.drawn;
  if (!def) {
    // after placeTile some engines clear `drawn`; fall back to any meeple-less
    // tile — but that's ambiguous. Prefer the drawn-def match when available.
  }
  let candidate: PlacedTile | undefined;
  for (const pt of g.board.values()) {
    if (pt.meeple) continue;
    if (def && pt.def.id === def.id && pt.rotation === g.drawnRotation) {
      candidate = pt; // keep last match; typically unique for the fresh tile
    }
  }
  if (candidate) return candidate;
  // fallback: last inserted meeple-less tile
  let last: PlacedTile | undefined;
  for (const pt of g.board.values()) if (!pt.meeple) last = pt;
  return last;
}

// ---- Placement scoring ----------------------------------------------------

/**
 * Cheap pre-score to rank placements before deep simulation. Higher = more
 * promising. Rewards adjacency count (more matched edges ⇒ often completes
 * features and grows our claims) and proximity to our own meeples.
 */
function preScore(g: GameState, p: LegalPlacement, aiId: number): number {
  let s = 0;
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  for (let side = 0; side < 4; side++) {
    const nb = g.board.get(`${p.x + DX[side]},${p.y + DY[side]}`);
    if (!nb) continue;
    s += 1; // each neighbour = a matched edge = progress toward completion
    if (nb.meeple) {
      // adjacent to a meeple: could complete (ours=good) — small bonus,
      // resolved precisely in the deep pass.
      s += nb.meeple.playerId === aiId ? 1.5 : 0.2;
    }
  }
  return s;
}

/**
 * Deep evaluation of a placement: simulate placeTile on a clone, evaluate the
 * best meeple option, and combine into a scalar. Also penalises handing
 * opponents easy completions (denial term).
 */
function evaluatePlacement(
  engine: Engine,
  g: GameState,
  p: LegalPlacement,
  difficulty: Difficulty,
): { score: number; meepleSegmentIndex: number } {
  const t = TUNING[difficulty];
  const sim = clone(engine, g);
  const aiId = g.players[g.current].id;

  const ok = engine.placeTile(sim, p.x, p.y, p.rotation);
  if (!ok) return { score: -Infinity, meepleSegmentIndex: -1 };

  const aiPlayer = sim.players[sim.current];
  const legalM = engine.legalMeeples(sim);

  // Evaluate best meeple on the simulated post-placement state.
  let bestMeepleVal = 0;
  let bestMeepleSeg = -1;
  const placed = findJustPlaced(sim);
  if (placed) {
    for (let i = 0; i < legalM.length; i++) {
      const lm = legalM[i];
      const seg = segOf(placed.def, lm.segmentIndex);
      if (!seg) continue;
      let v = meepleValue(sim, aiPlayer, placed.x, placed.y, placed.rotation, seg, t);
      v += prand(g.turn * 53 + i) * 0.01;
      if (v > bestMeepleVal) {
        bestMeepleVal = v;
        bestMeepleSeg = lm.segmentIndex;
      }
    }
  }

  // Base placement value: how much this position advances OUR standing.
  // Reward completing/growing our features (captured via meeple value), plus a
  // structural term for edges matched (progress) and a denial term.
  let structural = 0;
  // opponent-feature effects, split by kind (cities are judged by ownership below)
  let roadHelpComplete = 0, roadEntangle = 0;   // finishing / growing their ROADS
  let cityHelpComplete = 0, cityEntangle = 0;    // finishing / growing their CITIES (non-aggressive)
  let contestAdj = 0;                            // opp CITY size we sit beside (contest setup)
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const OPP = [2, 3, 0, 1];
  const placedTile = placed;
  if (placedTile) {
    for (let side = 0; side < 4; side++) {
      const nb = sim.board.get(`${placedTile.x + DX[side]},${placedTile.y + DY[side]}`);
      if (!nb) continue;
      structural += 0.4;
      if (nb.meeple && nb.meeple.playerId !== aiId) {
        const inSide = OPP[side];
        for (const ns of nb.def.segments) {
          if (ns.kind !== "city" && ns.kind !== "road") continue;
          if (!ns.edges.some((e) => ((e + nb.rotation) % 4) === inSide)) continue;
          if (nb.meeple.segmentIndex === ns.index) {
            const sv = surveyFeature(sim, placedTile.x, placedTile.y, placedTile.rotation, ns);
            const per = ns.kind === "city" ? CITY_TILE_VALUE : ROAD_TILE_VALUE;
            const help = sv.tiles * per + sv.pennants * PENNANT_VALUE;
            if (ns.kind === "road") {
              if (sv.complete) roadHelpComplete += help; else roadEntangle += help * 0.25;
            } else {
              if (sv.complete) cityHelpComplete += help; else cityEntangle += help * 0.25;
              contestAdj += sv.tiles;
            }
          }
        }
      }
    }
  }

  const ownSeg = bestMeepleSeg >= 0 && placedTile ? segOf(placedTile.def, bestMeepleSeg) : undefined;

  // Never gift an opponent a completed/grown ROAD — a penalty for every difficulty.
  let score = bestMeepleVal + structural
    - roadHelpComplete * Math.max(t.denyWeight, 1)
    - roadEntangle * Math.max(t.denyWeight, 0.4);

  if (t.aggression > 0 && placedTile) {
    // AGGRESSIVE: judge every city this placement touches by who will hold it.
    //  - our knights already merged in AND we hold the majority/tie → we SHARE or
    //    STEAL it: reward (this is "joining their city to take the points").
    //  - opponent holds it and we have no stake → we'd just be handing them points
    //    (worst when we complete it): heavy penalty, so it stops finishing your cities.
    let contest = 0, gift = 0;
    const seen = new Set<string>();
    for (const seg of placedTile.def.segments) {
      if (seg.kind !== "city") continue;
      const a = analyzeCity(sim, placedTile.x, placedTile.y, seg.index, aiId);
      if (!a || seen.has(a.key)) continue;
      seen.add(a.key);
      const pts = a.tiles * CITY_TILE_VALUE + a.pennants * PENNANT_VALUE;
      if (a.oppCount > 0 && a.aiCount > 0) {
        if (a.aiCount >= a.oppCount) contest += pts * (a.complete ? 1.3 : 0.9); // share / steal
        else gift += pts * 0.7;                                                 // we're the minority
      } else if (a.oppCount > 0) {
        gift += pts * (a.complete ? 1.6 : 0.5);                                 // pure gift to them
      }
    }
    score += contest * t.aggression - gift * (t.aggression + 1);
    // small nudge to plant a fresh knight right beside their city (sets up a merge)
    if (ownSeg?.kind === "city") score += contestAdj * t.aggression * 0.3;
  } else {
    score -= cityHelpComplete * Math.max(t.denyWeight, 1);
    score -= cityEntangle * t.denyWeight;
  }

  return { score, meepleSegmentIndex: bestMeepleSeg };
}

// ---- Public entry point ---------------------------------------------------

/**
 * Choose a full turn (placement + meeple decision) for the current AI player.
 * Never mutates `g`.
 */
export function chooseTurn(
  engine: Engine,
  g: GameState,
  difficulty: Difficulty = "normal",
): AiTurn {
  const t = TUNING[difficulty];
  const placements = engine.legalPlacements(g);

  // Defensive sentinel: caller handles discard when there are truly none.
  if (!placements.length) {
    return { placement: { x: 0, y: 0, rotation: 0 }, meepleSegmentIndex: -1 };
  }

  const aiId = g.players[g.current].id;

  // EASY: mostly random among legal placements + rare/random meeple.
  if (t.random) {
    const idx = Math.floor(prand(g.turn * 13 + 5) * placements.length);
    const placement = placements[Math.min(idx, placements.length - 1)];
    // simulate to get legal meeples, then apply easy meeple policy.
    const sim = clone(engine, g);
    let meepleSeg = -1;
    if (engine.placeTile(sim, placement.x, placement.y, placement.rotation)) {
      meepleSeg = bestMeeple(engine, sim, "easy");
    }
    return { placement, meepleSegmentIndex: meepleSeg };
  }

  // NORMAL / HARD: pre-score, cap candidates, deep-evaluate the top-K.
  const ranked = placements
    .map((p, i) => ({ p, i, pre: preScore(g, p, aiId) }))
    .sort((a, b) => b.pre - a.pre || a.i - b.i)
    .slice(0, t.candidateCap);

  let best: AiTurn | null = null;
  let bestScore = -Infinity;

  for (const { p, i } of ranked) {
    const { score, meepleSegmentIndex } = evaluatePlacement(engine, g, p, difficulty);
    // deterministic tie-break derived from turn + candidate index (no RNG).
    const jittered = score + prand(g.turn * 71 + i) * 0.001;
    if (jittered > bestScore) {
      bestScore = jittered;
      best = { placement: p, meepleSegmentIndex };
    }
  }

  if (!best) {
    // extremely defensive: fall back to first legal placement, no meeple.
    return { placement: placements[0], meepleSegmentIndex: -1 };
  }
  return best;
}
