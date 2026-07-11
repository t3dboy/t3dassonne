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
} from "../core/types";

export type Difficulty = "easy" | "normal" | "hard";

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
}

const TUNING: Record<Difficulty, Tuning> = {
  easy: {
    candidateCap: 6,
    denyWeight: 0,
    speculativeWeight: 0.35,
    reserve: 3,
    random: true,
    farmAppetite: 0.05,
  },
  normal: {
    candidateCap: 12,
    denyWeight: 0.6,
    speculativeWeight: 0.8,
    reserve: 2,
    random: false,
    farmAppetite: 0.25,
  },
  hard: {
    candidateCap: 20,
    denyWeight: 1.0,
    speculativeWeight: 1.0,
    reserve: 1,
    random: false,
    farmAppetite: 0.5,
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
    // Farmer: only occasionally, and only if plentiful meeples.
    if (meeplesLeft <= t.reserve + 1) return -50;
    const cities = seg.adjacentCitySegments ? seg.adjacentCitySegments.length : 0;
    if (cities === 0) return -50;
    // 3 pts per completed city at end; discount heavily (end-only, uncertain).
    const raw = cities * 3;
    return raw * 0.5 * t.farmAppetite;
  }

  // city or road.
  const perTile = seg.kind === "city" ? CITY_TILE_VALUE : ROAD_TILE_VALUE;
  const solidPoints = survey.tiles * perTile + survey.pennants * PENNANT_VALUE;

  if (survey.complete) {
    // completing our own feature right now — full, guaranteed points.
    return solidPoints;
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
  if (seg.kind === "city") val *= 1.1;

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
  let deny = 0;
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const OPP = [2, 3, 0, 1];
  const placedTile = placed;
  if (placedTile) {
    for (let side = 0; side < 4; side++) {
      const nb = sim.board.get(`${placedTile.x + DX[side]},${placedTile.y + DY[side]}`);
      if (!nb) continue;
      structural += 0.4;
      // If this neighbour has an opponent meeple on a feature we're extending,
      // we may be helping them (or, if it completes for them, definitely).
      if (nb.meeple && nb.meeple.playerId !== aiId) {
        // find the neighbour segment we connect to and survey its completeness.
        const inSide = OPP[side];
        for (const ns of nb.def.segments) {
          if (ns.kind !== "city" && ns.kind !== "road") continue;
          const touches = ns.edges.some((e) => ((e + nb.rotation) % 4) === inSide);
          if (!touches) continue;
          if (nb.meeple.segmentIndex === ns.index) {
            const sv = surveyFeature(sim, placedTile.x, placedTile.y, placedTile.rotation, ns);
            // helping an opponent grow: penalty; completing for them: bigger.
            const per = ns.kind === "city" ? CITY_TILE_VALUE : ROAD_TILE_VALUE;
            const help = sv.tiles * per + sv.pennants * PENNANT_VALUE;
            deny += sv.complete ? help : help * 0.25;
          }
        }
      }
    }
  }

  const score =
    bestMeepleVal * 1.0 + structural - deny * t.denyWeight;

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
