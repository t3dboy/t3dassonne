// ============================================================================
// T3dassonne — Rules engine.
//
// Pure game logic: seeded deck, rotation math, placement legality, a whole-board
// union-find over feature segments (city / road / cloister / field), completion
// detection + scoring, turn/phase state machine, and final (end-of-game) scoring
// including farms.
//
// Everything is expressed against the shared contract in ../core/types.ts.
// Tile segments in tiles.ts are authored in the UNROTATED (rotation 0) frame;
// this module applies each placed tile's rotation when reasoning about the world.
// ============================================================================

import {
  type EdgeType,
  type Engine,
  type FeatureKind,
  type GameState,
  type GridPos,
  type LegalMeeple,
  type LegalPlacement,
  type Player,
  type PlacedTile,
  type Rotation,
  type ScoreEvent,
  type Segment,
  type Side,
  type TileDef,
  posKey,
} from "../core/types";
import {
  TILE_DEFS,
  START_TILE_ID,
  buildDeck,
  buildRiverMiddles,
  RIVER_SOURCE_ID,
  RIVER_LAKE_ID,
} from "../core/tiles";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic so games are reproducible/testable.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates using a provided rng. */
function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// ---------------------------------------------------------------------------
// Rotation math.
//
// Sides: N=0 E=1 S=2 W=3 (clockwise). A 90° CW rotation by r maps unrotated
// side k to world side (k + r) % 4.
//
// Field half-edges: 0..7 clockwise from north-west. A 90° CW step advances by
// two half-edges, so unrotated node h maps to world node (h + 2r) % 8.
// ---------------------------------------------------------------------------

/** World edge types per side after rotating a tile's unrotated edges by `rotation`. */
export function rotateEdges(
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  rotation: Rotation,
): [EdgeType, EdgeType, EdgeType, EdgeType] {
  const out: EdgeType[] = new Array(4);
  for (let k = 0; k < 4; k++) out[(k + rotation) % 4] = edges[k];
  return out as [EdgeType, EdgeType, EdgeType, EdgeType];
}

/** Rotate an unrotated Side to its world-facing Side. */
function rotSide(side: number, rotation: Rotation): Side {
  return (((side + rotation) % 4) + 4) % 4 as Side;
}
/** Inverse: given a world-facing Side, which unrotated side maps to it. */
function unrotSide(worldSide: number, rotation: Rotation): Side {
  return (((worldSide - rotation) % 4) + 4) % 4 as Side;
}
/** Rotate an unrotated half-edge node (0..7) to its world-facing node. */
function rotNode(node: number, rotation: Rotation): number {
  return (((node + 2 * rotation) % 8) + 8) % 8;
}

/**
 * Meeple draw position (tile-local 0..1) for a segment, rotated to match how
 * the tile is displayed. Rotation is 90° CW about the tile centre (0.5,0.5).
 */
export function rotatedSpot(
  def: TileDef,
  segmentIndex: number,
  rotation: Rotation,
): { x: number; y: number } {
  const s = def.segments[segmentIndex];
  let { x, y } = s.spot;
  for (let i = 0; i < rotation; i++) {
    // 90° CW about centre: (x,y) -> (1-y, x)
    const nx = 1 - y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Point → segment hit testing (unrotated). Used by UI for meeple tap targeting.
// The point given is in the tile's UNROTATED 0..1 frame (caller un-rotates the
// tap first, or passes an unrotated tile). Returns the unrotated segment index,
// or -1 if nothing sensible is hit.
// ---------------------------------------------------------------------------

/**
 * Which unrotated segment index a 0..1 local point maps to. We simply pick the
 * segment whose `spot` is nearest to the point (segments' spots are laid out to
 * be representative click targets), which is robust for tap selection.
 */
export function segmentAtPoint(placed: PlacedTile, localX: number, localY: number): number {
  const segs = placed.def.segments;
  if (segs.length === 0) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const s of segs) {
    const dx = s.spot.x - localX;
    const dy = s.spot.y - localY;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = s.index;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Deep clone (for AI lookahead). New Map + cloned placed tiles / players / deck.
// TileDefs are shared (immutable) but the PlacedTile wrappers + meeple objects
// are copied so mutation of the clone never touches the original.
// ---------------------------------------------------------------------------

export function cloneState(g: GameState): GameState {
  const board = new Map<string, PlacedTile>();
  for (const [k, t] of g.board) {
    board.set(k, {
      def: t.def, // immutable, shared
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      meeple: t.meeple ? { playerId: t.meeple.playerId, segmentIndex: t.meeple.segmentIndex } : undefined,
    });
  }
  return {
    players: g.players.map((p) => ({ ...p })),
    current: g.current,
    board,
    deck: g.deck.slice(),
    drawn: g.drawn, // TileDef immutable
    drawnRotation: g.drawnRotation,
    phase: g.phase,
    turn: g.turn,
    passAndPlay: g.passAndPlay,
  };
}

// ---------------------------------------------------------------------------
// A hidden PRNG per game. We keep it in a side-table keyed by GameState so the
// GameState shape (defined in types.ts) stays clean. Clones inherit a fresh rng
// derived from the parent so lookahead doesn't perturb the real game's stream.
// ---------------------------------------------------------------------------

const rngTable = new WeakMap<GameState, () => number>();
function rngFor(g: GameState): () => number {
  let r = rngTable.get(g);
  if (!r) {
    // Fallback deterministic rng if state wasn't created via newGame.
    r = mulberry32(0x9e3779b9);
    rngTable.set(g, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Neighbour helpers.
// ---------------------------------------------------------------------------

/** dx,dy for each side N,E,S,W. */
const SIDE_DELTA: Record<Side, [number, number]> = {
  0: [0, -1], // N
  1: [1, 0], // E
  2: [0, 1], // S
  3: [-1, 0], // W
};
/** opposite side. */
const OPP: Record<Side, Side> = { 0: 2, 1: 3, 2: 0, 3: 1 };

/**
 * Field half-edge border mapping. For UNROTATED node indices AFTER each tile's
 * rotation has been applied, a tile's world-facing node on a given side maps to
 * the neighbour's world-facing node across that border. Because we work in WORLD
 * node space, the mapping is symmetric per side:
 *   N side (world): 0<->5, 1<->4
 *   E side (world): 2<->7, 3<->6
 *   S side (world): 4<->1, 5<->0
 *   W side (world): 6<->3, 7<->2
 * (This is the same relation the contract states for unrotated nodes; in world
 *  space it holds for the corresponding rotated nodes.)
 */
const FIELD_BORDER: Record<Side, [number, number][]> = {
  0: [[0, 5], [1, 4]], // N
  1: [[2, 7], [3, 6]], // E
  2: [[4, 1], [5, 0]], // S
  3: [[6, 3], [7, 2]], // W
};

/** World-facing edge type of a placed tile on a given world side. */
function worldEdge(t: PlacedTile, worldSide: Side): EdgeType {
  return t.def.edges[unrotSide(worldSide, t.rotation)];
}

// ---------------------------------------------------------------------------
// Feature-node identity across the board. A "node" is (posKey, segmentIndex) —
// a specific segment of a specific placed tile. We union nodes that belong to
// the same feature. Keys are strings "x,y#segIndex".
// ---------------------------------------------------------------------------

function nodeKey(x: number, y: number, segIndex: number): string {
  return `${x},${y}#${segIndex}`;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(a: string): string {
    let root = a;
    let p = this.parent.get(root);
    while (p !== undefined && p !== root) {
      root = p;
      p = this.parent.get(root);
    }
    // path-compress
    let cur = a;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  add(a: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
  }
}

/**
 * Build a whole-board union-find over every tile's city/road/field segments.
 * Cloisters are standalone (never unioned) — each is its own feature.
 */
function buildGraph(board: Map<string, PlacedTile>): UnionFind {
  const uf = new UnionFind();
  // First register every segment as its own node.
  for (const t of board.values()) {
    for (const s of t.def.segments) uf.add(nodeKey(t.x, t.y, s.index));
  }
  // Then connect across each occupied border. Iterate each tile; for each of the
  // 4 sides look at the neighbour and union matching city/road/field segments.
  for (const t of board.values()) {
    for (let ws = 0 as Side; ws < 4; ws = (ws + 1) as Side) {
      const [dx, dy] = SIDE_DELTA[ws];
      const nb = board.get(posKey(t.x + dx, t.y + dy));
      if (!nb) continue;
      const nbSide = OPP[ws];

      // --- city / road: connect the segment on t covering world side ws to the
      //     segment on nb covering world side nbSide, iff the edge types match.
      const eType = worldEdge(t, ws);
      if (eType === "city" || eType === "road") {
        const segA = segCoveringSide(t, ws, eType);
        const segB = segCoveringSide(nb, nbSide, eType);
        if (segA >= 0 && segB >= 0) {
          uf.union(nodeKey(t.x, t.y, segA), nodeKey(nb.x, nb.y, segB));
        }
      }

      // --- fields: connect matching world half-edges across the border.
      for (const [na, nbn] of FIELD_BORDER[ws]) {
        const segA = fieldSegWithWorldNode(t, na);
        const segB = fieldSegWithWorldNode(nb, nbn);
        if (segA >= 0 && segB >= 0) {
          uf.union(nodeKey(t.x, t.y, segA), nodeKey(nb.x, nb.y, segB));
        }
      }
    }
  }
  return uf;
}

/** Segment index on tile `t` whose (rotated) sides cover world side `ws` and is of kind matching edgeType. */
function segCoveringSide(t: PlacedTile, ws: Side, edgeType: "city" | "road"): number {
  for (const s of t.def.segments) {
    if (s.kind !== edgeType) continue;
    for (const unrotSideIdx of s.edges) {
      if (rotSide(unrotSideIdx, t.rotation) === ws) return s.index;
    }
  }
  return -1;
}

/** Field segment index on tile `t` that owns the given WORLD half-edge node. */
function fieldSegWithWorldNode(t: PlacedTile, worldNode: number): number {
  for (const s of t.def.segments) {
    if (s.kind !== "field") continue;
    for (const unrotNode of s.edges) {
      if (rotNode(unrotNode, t.rotation) === worldNode) return s.index;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Meeple / feature-component helpers.
// ---------------------------------------------------------------------------

/** All meeples on the board as {root, playerId, kind, x,y,segIndex}. */
interface BoardMeeple {
  root: string;
  playerId: number;
  kind: FeatureKind;
  x: number;
  y: number;
  segIndex: number;
}
function collectMeeples(board: Map<string, PlacedTile>, uf: UnionFind): BoardMeeple[] {
  const out: BoardMeeple[] = [];
  for (const t of board.values()) {
    if (!t.meeple) continue;
    const seg = t.def.segments[t.meeple.segmentIndex];
    const key = nodeKey(t.x, t.y, t.meeple.segmentIndex);
    out.push({
      root: uf.find(key),
      playerId: t.meeple.playerId,
      kind: seg.kind,
      x: t.x,
      y: t.y,
      segIndex: t.meeple.segmentIndex,
    });
  }
  return out;
}

/** Does the connected component containing (x,y,segIndex) contain ANY meeple? */
function componentHasMeeple(
  board: Map<string, PlacedTile>,
  uf: UnionFind,
  x: number,
  y: number,
  segIndex: number,
): boolean {
  const root = uf.find(nodeKey(x, y, segIndex));
  for (const t of board.values()) {
    if (!t.meeple) continue;
    if (uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === root) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Completion detection.
//
// A city/road component is COMPLETE iff every side reference across all its
// segments is backed by an actual placed neighbour with a matching edge, i.e.
// the feature has no open edge. We check by walking every segment in the
// component and, for each world side it exposes, requiring a neighbour tile.
// A cloister is complete iff all 8 surrounding cells are occupied.
// ---------------------------------------------------------------------------

/** All (tile, segment) members of the component rooted at `root`. */
function componentMembers(
  board: Map<string, PlacedTile>,
  uf: UnionFind,
  root: string,
): { t: PlacedTile; seg: Segment }[] {
  const out: { t: PlacedTile; seg: Segment }[] = [];
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (uf.find(nodeKey(t.x, t.y, s.index)) === root) out.push({ t, seg: s });
    }
  }
  return out;
}

/** Is the city/road component complete (no open edges)? */
function isCityRoadComplete(
  board: Map<string, PlacedTile>,
  members: { t: PlacedTile; seg: Segment }[],
): boolean {
  for (const { t, seg } of members) {
    for (const unrotSideIdx of seg.edges) {
      const ws = rotSide(unrotSideIdx, t.rotation);
      const [dx, dy] = SIDE_DELTA[ws];
      if (!board.has(posKey(t.x + dx, t.y + dy))) return false;
    }
  }
  return true;
}

/** How many surrounding cells (of 8) around (x,y) are occupied. */
function cloisterNeighbours(board: Map<string, PlacedTile>, x: number, y: number): number {
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (board.has(posKey(x + dx, y + dy))) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Scoring of a single completed component. Determines majority owners, points,
// and which meeples return. `unique tiles` counted for road/city tile counts.
// ---------------------------------------------------------------------------

interface CompletedFeature {
  kind: FeatureKind;
  points: number; // points per winning player
  members: { t: PlacedTile; seg: Segment }[];
}

/** Distinct tile positions covered by a set of members. */
function distinctTiles(members: { t: PlacedTile; seg: Segment }[]): GridPos[] {
  const seen = new Set<string>();
  const out: GridPos[] = [];
  for (const { t } of members) {
    const k = posKey(t.x, t.y);
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ x: t.x, y: t.y });
    }
  }
  return out;
}

/** Score value for a completed city component. */
function cityPoints(members: { t: PlacedTile; seg: Segment }[]): number {
  const tiles = distinctTiles(members).length;
  let pennants = 0;
  for (const { seg } of members) if (seg.pennant) pennants++;
  return tiles * 2 + pennants * 2;
}

/** Score value for a completed road component. */
function roadPoints(members: { t: PlacedTile; seg: Segment }[]): number {
  return distinctTiles(members).length; // 1 pt / tile
}

/**
 * Build a ScoreEvent for a completed component: majority resolution over the
 * meeples in the component. Returns null if no meeples (nobody scores, nothing
 * returned) — completion is still tracked but produces no event.
 */
function scoreComponentEvent(
  board: Map<string, PlacedTile>,
  uf: UnionFind,
  root: string,
  kind: FeatureKind,
  points: number,
  members: { t: PlacedTile; seg: Segment }[],
): ScoreEvent | null {
  // Count meeples per player in this component.
  const perPlayer = new Map<number, number>();
  const returned: { playerId: number }[] = [];
  for (const t of board.values()) {
    if (!t.meeple) continue;
    if (uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) !== root) continue;
    perPlayer.set(t.meeple.playerId, (perPlayer.get(t.meeple.playerId) ?? 0) + 1);
    returned.push({ playerId: t.meeple.playerId });
  }
  if (perPlayer.size === 0) return null;
  let max = 0;
  for (const c of perPlayer.values()) if (c > max) max = c;
  const winners: number[] = [];
  for (const [pid, c] of perPlayer) if (c === max) winners.push(pid);
  return {
    playerIds: winners,
    points,
    kind,
    tiles: distinctTiles(members),
    returnedMeeples: returned,
  };
}

/**
 * Apply a ScoreEvent to the state: add points to winners, return meeples (clear
 * meeple markers for every returned meeple in the given root/component and bump
 * meeplesLeft). We clear by matching the component root.
 */
function applyScoreEvent(g: GameState, ev: ScoreEvent, clearRoot: string | null, uf: UnionFind | null): void {
  for (const pid of ev.playerIds) {
    const p = g.players.find((pl) => pl.id === pid);
    if (p) p.score += ev.points;
  }
  if (clearRoot && uf) {
    for (const t of g.board.values()) {
      if (!t.meeple) continue;
      if (uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === clearRoot) {
        const owner = g.players.find((pl) => pl.id === t.meeple!.playerId);
        if (owner) owner.meeplesLeft++;
        t.meeple = undefined;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Completed-feature scanning after a placement. Returns the ScoreEvents and
// mutates state (adds points, returns meeples). Cloisters (both the placed
// tile's own cloister and neighbours') are handled here too.
// ---------------------------------------------------------------------------

function scoreCompletedFeatures(g: GameState): ScoreEvent[] {
  const board = g.board;
  const uf = buildGraph(board);
  const events: ScoreEvent[] = [];

  // --- City & road components. Group segments by root, restricted to city/road
  //     that actually carry a meeple somewhere (only meeple'd features can score,
  //     but we must still detect completion to return meeples). We scan all roots.
  const cityRoadRoots = new Map<string, { kind: "city" | "road"; members: { t: PlacedTile; seg: Segment }[] }>();
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "city" && s.kind !== "road") continue;
      const root = uf.find(nodeKey(t.x, t.y, s.index));
      let entry = cityRoadRoots.get(root);
      if (!entry) {
        entry = { kind: s.kind, members: [] };
        cityRoadRoots.set(root, entry);
      }
      entry.members.push({ t, seg: s });
    }
  }

  for (const [root, { kind, members }] of cityRoadRoots) {
    if (!isCityRoadComplete(board, members)) continue;
    // Only produce/return if there is at least one meeple in the component.
    const hasMeeple = members.some(
      ({ t }) => t.meeple && uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === root,
    );
    if (!hasMeeple) continue;
    const pts = kind === "city" ? cityPoints(members) : roadPoints(members);
    const ev = scoreComponentEvent(board, uf, root, kind, pts, members);
    if (ev) {
      applyScoreEvent(g, ev, root, uf);
      events.push(ev);
    }
  }

  // --- Cloisters. A cloister completes when all 8 neighbours are filled. Check
  //     every cloister tile on the board (placing a tile can complete a
  //     neighbour's cloister). Only score+return if it carries a meeple.
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "cloister") continue;
      if (!t.meeple || t.meeple.segmentIndex !== s.index) continue; // only meeple'd cloisters score
      if (cloisterNeighbours(board, t.x, t.y) !== 8) continue;
      const pts = 9; // 1 + 8
      const owner = t.meeple.playerId;
      const p = g.players.find((pl) => pl.id === owner);
      if (p) {
        p.score += pts;
        p.meeplesLeft++;
      }
      // gather the 9 tiles for highlight
      const tiles: GridPos[] = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if (board.has(posKey(t.x + dx, t.y + dy))) tiles.push({ x: t.x + dx, y: t.y + dy });
      events.push({
        playerIds: [owner],
        points: pts,
        kind: "cloister",
        tiles,
        returnedMeeples: [{ playerId: owner }],
      });
      t.meeple = undefined;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Final scoring (deck exhausted). Incomplete features + farms.
// ---------------------------------------------------------------------------

function finalScoreImpl(g: GameState): ScoreEvent[] {
  const board = g.board;
  const uf = buildGraph(board);
  const events: ScoreEvent[] = [];

  // --- Incomplete city / road / cloister with meeples on them. Group like above.
  const cityRoadRoots = new Map<string, { kind: "city" | "road"; members: { t: PlacedTile; seg: Segment }[] }>();
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "city" && s.kind !== "road") continue;
      const root = uf.find(nodeKey(t.x, t.y, s.index));
      let entry = cityRoadRoots.get(root);
      if (!entry) {
        entry = { kind: s.kind, members: [] };
        cityRoadRoots.set(root, entry);
      }
      entry.members.push({ t, seg: s });
    }
  }
  for (const [root, { kind, members }] of cityRoadRoots) {
    const hasMeeple = members.some(
      ({ t }) => t.meeple && uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === root,
    );
    if (!hasMeeple) continue;
    let pts: number;
    if (kind === "road") {
      pts = distinctTiles(members).length; // 1 / tile
    } else {
      // incomplete city: 1 / tile + 1 / pennant
      const tiles = distinctTiles(members).length;
      let pennants = 0;
      for (const { seg } of members) if (seg.pennant) pennants++;
      pts = tiles + pennants;
    }
    const ev = scoreComponentEvent(board, uf, root, kind, pts, members);
    if (ev) {
      applyScoreEvent(g, ev, root, uf);
      events.push(ev);
    }
  }

  // --- Incomplete cloisters with meeples: 1 + number of surrounding tiles.
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "cloister") continue;
      if (!t.meeple || t.meeple.segmentIndex !== s.index) continue;
      const nb = cloisterNeighbours(board, t.x, t.y);
      const pts = 1 + nb;
      const owner = t.meeple.playerId;
      const p = g.players.find((pl) => pl.id === owner);
      if (p) {
        p.score += pts;
        p.meeplesLeft++;
      }
      const tiles: GridPos[] = [{ x: t.x, y: t.y }];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if (!(dx === 0 && dy === 0) && board.has(posKey(t.x + dx, t.y + dy)))
            tiles.push({ x: t.x + dx, y: t.y + dy });
      events.push({
        playerIds: [owner],
        points: pts,
        kind: "cloister",
        tiles,
        returnedMeeples: [{ playerId: owner }],
      });
      t.meeple = undefined;
    }
  }

  // --- FARMS. Each field component with meeples scores 3 pts per DISTINCT
  //     COMPLETED city that the field touches. Majority rules among the field's
  //     meeples. Completed = the bordering city component has no open edges.
  //
  //     Step 1: precompute which city roots are complete.
  const cityRootComplete = new Map<string, boolean>();
  {
    const cityRoots = new Map<string, { t: PlacedTile; seg: Segment }[]>();
    for (const t of board.values()) {
      for (const s of t.def.segments) {
        if (s.kind !== "city") continue;
        const root = uf.find(nodeKey(t.x, t.y, s.index));
        const arr = cityRoots.get(root) ?? [];
        arr.push({ t, seg: s });
        cityRoots.set(root, arr);
      }
    }
    for (const [root, members] of cityRoots) {
      cityRootComplete.set(root, isCityRoadComplete(board, members));
    }
  }

  // Step 2: group field segments by root; for each, collect meeples & the set of
  // completed city roots it borders (via each field segment's adjacentCitySegments,
  // resolved to the city component root through the same tile).
  const fieldRoots = new Map<string, { members: { t: PlacedTile; seg: Segment }[] }>();
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "field") continue;
      const root = uf.find(nodeKey(t.x, t.y, s.index));
      const entry = fieldRoots.get(root) ?? { members: [] };
      entry.members.push({ t, seg: s });
      fieldRoots.set(root, entry);
    }
  }

  for (const [root, { members }] of fieldRoots) {
    // meeples on this field component
    const perPlayer = new Map<number, number>();
    const returned: { playerId: number }[] = [];
    for (const { t } of members) {
      if (t.meeple && uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === root) {
        perPlayer.set(t.meeple.playerId, (perPlayer.get(t.meeple.playerId) ?? 0) + 1);
      }
    }
    if (perPlayer.size === 0) continue; // unowned farm scores nothing

    // distinct completed city roots this farm borders
    const cityRootsTouched = new Set<string>();
    for (const { t, seg } of members) {
      const adj = seg.adjacentCitySegments ?? [];
      for (const citySegIdx of adj) {
        const cRoot = uf.find(nodeKey(t.x, t.y, citySegIdx));
        if (cityRootComplete.get(cRoot)) cityRootsTouched.add(cRoot);
      }
    }
    const pts = cityRootsTouched.size * 3;
    if (pts === 0) {
      // still return meeples (they're on the board) but no points — we return them
      // for tidiness; majority irrelevant. Emit no event when 0 points.
    }
    // majority
    let max = 0;
    for (const c of perPlayer.values()) if (c > max) max = c;
    const winners: number[] = [];
    for (const [pid, c] of perPlayer) if (c === max) winners.push(pid);

    // return farmer meeples
    for (const { t } of members) {
      if (t.meeple && uf.find(nodeKey(t.x, t.y, t.meeple.segmentIndex)) === root) {
        const owner = g.players.find((pl) => pl.id === t.meeple!.playerId);
        if (owner) owner.meeplesLeft++;
        returned.push({ playerId: t.meeple.playerId });
        t.meeple = undefined;
      }
    }
    if (pts > 0) {
      for (const pid of winners) {
        const p = g.players.find((pl) => pl.id === pid);
        if (p) p.score += pts;
      }
      events.push({
        playerIds: winners,
        points: pts,
        kind: "field",
        tiles: distinctTiles(members),
        returnedMeeples: returned,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Placement legality.
// ---------------------------------------------------------------------------

/** Is placing `def` at (x,y,rotation) legal on the current board? */
function isLegalPlacement(
  board: Map<string, PlacedTile>,
  def: TileDef,
  x: number,
  y: number,
  rotation: Rotation,
): boolean {
  if (board.has(posKey(x, y))) return false; // cell must be empty
  const worldEdges = rotateEdges(def.edges, rotation);
  const isRiverTile = def.edges.includes("river");
  let hasNeighbour = false;
  for (let ws = 0 as Side; ws < 4; ws = (ws + 1) as Side) {
    const [dx, dy] = SIDE_DELTA[ws];
    const nb = board.get(posKey(x + dx, y + dy));
    if (!nb) continue;
    hasNeighbour = true;
    const mine = worldEdges[ws];
    const theirs = worldEdge(nb, OPP[ws]);
    if (mine !== theirs) return false;
  }
  if (!hasNeighbour) return false;

  // River tiles follow the strict River rules: the river is ONE waterway that
  // flows in a single direction and never loops or makes a U-turn.
  if (isRiverTile) {
    const isRiverCell = (cx: number, cy: number): boolean => {
      const c = board.get(posKey(cx, cy));
      return !!c && c.def.edges.includes("river");
    };
    let connections = 0;
    for (let ws = 0 as Side; ws < 4; ws = (ws + 1) as Side) {
      if (worldEdges[ws] !== "river") continue;
      const [dx, dy] = SIDE_DELTA[ws];
      const ox = x + dx,
        oy = y + dy;
      if (board.has(posKey(ox, oy))) {
        connections++; // this river edge meets an existing river tile
      } else {
        // an open river end must NOT run alongside an existing river tile —
        // that would be a U-turn or the beginning of a loop.
        for (let d2 = 0 as Side; d2 < 4; d2 = (d2 + 1) as Side) {
          const [ex, ey] = SIDE_DELTA[d2];
          if (isRiverCell(ox + ex, oy + ey)) return false;
        }
      }
    }
    // Must extend EXACTLY ONE open end — never zero (floating) or two (a loop
    // / joining two branches).
    if (connections !== 1) return false;
  }
  return true;
}

/** All empty cells adjacent to the board. */
function candidateCells(board: Map<string, PlacedTile>): GridPos[] {
  const seen = new Set<string>();
  const out: GridPos[] = [];
  for (const t of board.values()) {
    for (let ws = 0 as Side; ws < 4; ws = (ws + 1) as Side) {
      const [dx, dy] = SIDE_DELTA[ws];
      const nx = t.x + dx;
      const ny = t.y + dy;
      const k = posKey(nx, ny);
      if (board.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push({ x: nx, y: ny });
    }
  }
  return out;
}

function legalPlacementsFor(board: Map<string, PlacedTile>, def: TileDef): LegalPlacement[] {
  const out: LegalPlacement[] = [];
  for (const cell of candidateCells(board)) {
    for (let r = 0 as Rotation; r < 4; r = (r + 1) as Rotation) {
      if (isLegalPlacement(board, def, cell.x, cell.y, r)) {
        out.push({ x: cell.x, y: cell.y, rotation: r });
      }
    }
  }
  return out;
}

/** Does the given tile type have ANY legal placement? (for discard rule) */
function tileHasAnyPlacement(board: Map<string, PlacedTile>, def: TileDef): boolean {
  for (const cell of candidateCells(board)) {
    for (let r = 0 as Rotation; r < 4; r = (r + 1) as Rotation) {
      if (isLegalPlacement(board, def, cell.x, cell.y, r)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Optional highlight helper: groups of tiles for currently-completed features.
// ---------------------------------------------------------------------------

export function completedFeatureTiles(g: GameState): GridPos[][] {
  const board = g.board;
  const uf = buildGraph(board);
  const groups: GridPos[][] = [];
  const cityRoadRoots = new Map<string, { kind: "city" | "road"; members: { t: PlacedTile; seg: Segment }[] }>();
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "city" && s.kind !== "road") continue;
      const root = uf.find(nodeKey(t.x, t.y, s.index));
      let entry = cityRoadRoots.get(root);
      if (!entry) {
        entry = { kind: s.kind, members: [] };
        cityRoadRoots.set(root, entry);
      }
      entry.members.push({ t, seg: s });
    }
  }
  for (const { members } of cityRoadRoots.values()) {
    if (isCityRoadComplete(board, members)) groups.push(distinctTiles(members));
  }
  for (const t of board.values()) {
    for (const s of t.def.segments) {
      if (s.kind !== "cloister") continue;
      if (cloisterNeighbours(board, t.x, t.y) === 8) {
        const tiles: GridPos[] = [];
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            if (board.has(posKey(t.x + dx, t.y + dy))) tiles.push({ x: t.x + dx, y: t.y + dy });
        groups.push(tiles);
      }
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Turn / game state machine.
// ---------------------------------------------------------------------------

function newGame(players: Player[], passAndPlay: boolean, seed?: number, river = false): GameState {
  const rng = mulberry32(seed ?? ((Math.floor(Date.now()) ^ 0x1234abcd) >>> 0));
  // Fresh player copies with clean score/meeples.
  const ps: Player[] = players.map((p) => ({ ...p, score: 0, meeplesLeft: 7 }));

  const land = buildDeck();
  shuffle(land, rng);

  const board = new Map<string, PlacedTile>();
  let deck: string[];
  if (river) {
    // The base River: pre-place the source at origin, play the 10 middle river
    // tiles (shuffled), then the lake (last) closes the single waterway, before
    // the normal land deck.
    const source = TILE_DEFS[RIVER_SOURCE_ID];
    board.set(posKey(0, 0), { def: source, x: 0, y: 0, rotation: 0 });
    const middles = buildRiverMiddles();
    shuffle(middles, rng);
    const riverDeck = [...middles, RIVER_LAKE_ID];
    deck = [...riverDeck, ...land];
  } else {
    const startDef = TILE_DEFS[START_TILE_ID];
    board.set(posKey(0, 0), { def: startDef, x: 0, y: 0, rotation: 0 });
    deck = land;
  }

  const g: GameState = {
    players: ps,
    current: 0,
    board,
    deck,
    drawn: null,
    drawnRotation: 0,
    phase: "placeTile",
    turn: 1,
    passAndPlay,
  };
  rngTable.set(g, rng);
  // Draw the first tile so the first player has something to place.
  drawTile(g);
  return g;
}

/**
 * Draw the next placeable tile into `drawn`. Skips (discards) tiles that have no
 * legal placement anywhere on the current board. Returns false if the deck is
 * exhausted without yielding a placeable tile.
 */
function drawTile(g: GameState): boolean {
  while (g.deck.length > 0) {
    const id = g.deck.shift()!;
    const def = TILE_DEFS[id];
    if (tileHasAnyPlacement(g.board, def)) {
      g.drawn = def;
      g.drawnRotation = 0;
      g.phase = "placeTile";
      return true;
    }
    // else discard and continue (Carcassonne unplaceable-tile rule)
  }
  g.drawn = null;
  return false;
}

function legalPlacements(g: GameState): LegalPlacement[] {
  if (!g.drawn) return [];
  return legalPlacementsFor(g.board, g.drawn);
}

function placeTile(g: GameState, x: number, y: number, rotation: Rotation): boolean {
  if (!g.drawn) return false;
  if (g.phase !== "placeTile") return false;
  if (!isLegalPlacement(g.board, g.drawn, x, y, rotation)) return false;
  g.board.set(posKey(x, y), { def: g.drawn, x, y, rotation });
  g.drawnRotation = rotation;
  g.phase = "placeMeeple";
  return true;
}

/** The tile placed this turn (last position we set drawn from). We track it by
 *  scanning for the tile whose def === g.drawn and that has no meeple yet at the
 *  just-placed cell. Simpler: remember it explicitly. */
const lastPlacedTable = new WeakMap<GameState, { x: number; y: number }>();

function legalMeeples(g: GameState): LegalMeeple[] {
  if (g.phase !== "placeMeeple" || !g.drawn) return [];
  const placed = findJustPlaced(g);
  if (!placed) return [];
  const player = g.players[g.current];
  if (player.meeplesLeft <= 0) return [];
  const uf = buildGraph(g.board);
  const out: LegalMeeple[] = [];
  for (const s of placed.def.segments) {
    // A segment is a legal meeple spot iff its whole connected component has no
    // meeple anywhere. Cloisters are standalone; check just this tile's meeple
    // (none yet since it was just placed).
    if (s.kind === "cloister") {
      out.push({ segmentIndex: s.index, kind: s.kind });
      continue;
    }
    if (!componentHasMeeple(g.board, uf, placed.x, placed.y, s.index)) {
      out.push({ segmentIndex: s.index, kind: s.kind });
    }
  }
  return out;
}

/** Locate the tile placed this turn. */
function findJustPlaced(g: GameState): PlacedTile | null {
  const lp = lastPlacedTable.get(g);
  if (lp) {
    const t = g.board.get(posKey(lp.x, lp.y));
    if (t) return t;
  }
  return null;
}

function placeMeeple(g: GameState, segmentIndex: number): ScoreEvent[] {
  if (g.phase !== "placeMeeple") return [];
  const placed = findJustPlaced(g);
  if (segmentIndex >= 0 && placed) {
    const player = g.players[g.current];
    // validate it's a legal spot and player has a meeple
    const legal = legalMeeples(g).some((m) => m.segmentIndex === segmentIndex);
    if (legal && player.meeplesLeft > 0) {
      placed.meeple = { playerId: player.id, segmentIndex };
      player.meeplesLeft--;
    }
  }
  // Placing a meeple can complete a feature — but we defer scoring to endTurn to
  // keep a single, well-defined scoring point. Return no events here.
  return [];
}

function endTurn(g: GameState): ScoreEvent[] {
  // 1) score completed features (adds points, returns meeples).
  const events = scoreCompletedFeatures(g);

  // 2) advance the game.
  if (g.deck.length === 0) {
    // Deck exhausted: the game is over. We deliberately do NOT run final scoring
    // here — it's left to finalScore() so the UI can animate the end-game tally one
    // feature at a time. finalScore() is idempotent, so headless callers that call
    // it after the loop still get the (single) final scoring.
    g.phase = "gameOver";
    g.drawn = null;
    return events;
  }

  // Advance current player.
  const next = (g.current + 1) % g.players.length;
  g.current = next;
  g.turn++;

  // Draw next tile (handles discard of unplaceable tiles). If none placeable and
  // deck runs dry during draw, the game is over (final scoring deferred as above).
  const ok = drawTile(g);
  if (!ok) {
    g.phase = "gameOver";
    g.drawn = null;
    return events;
  }

  // Pass-and-play hand-off screen before a human's turn.
  if (g.passAndPlay && g.players[g.current].kind === "human") {
    g.phase = "h&off";
  } else {
    g.phase = "placeTile";
  }
  return events;
}

function finalScore(g: GameState): ScoreEvent[] {
  const events = finalScoreImpl(g);
  g.phase = "gameOver";
  return events;
}

// ---------------------------------------------------------------------------
// Wire placeTile to record the just-placed cell (so legalMeeples/placeMeeple can
// find it). We wrap the raw placeTile.
// ---------------------------------------------------------------------------

function placeTileTracked(g: GameState, x: number, y: number, rotation: Rotation): boolean {
  const ok = placeTile(g, x, y, rotation);
  if (ok) lastPlacedTable.set(g, { x, y });
  return ok;
}

// ---------------------------------------------------------------------------
// The exported Engine object.
// ---------------------------------------------------------------------------

export const engine: Engine = {
  newGame,
  drawTile,
  legalPlacements,
  placeTile: placeTileTracked,
  legalMeeples,
  placeMeeple,
  endTurn,
  finalScore,
};
