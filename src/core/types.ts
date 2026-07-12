// ============================================================================
// T3dassonne — Shared type contract. ALL subsystems build against this file.
// Do not change signatures here without coordinating; add, don't break.
// ============================================================================

// ---- Geometry -------------------------------------------------------------

/** Side index around a tile. N=0, E=1, S=2, W=3 (clockwise from top). */
export type Side = 0 | 1 | 2 | 3;
export const N: Side = 0;
export const E: Side = 1;
export const S: Side = 2;
export const W: Side = 3;

/**
 * Farm half-edge index, 0..7, clockwise starting at the north-west half.
 *  0 = N-left(west)   1 = N-right(east)
 *  2 = E-top(north)   3 = E-bottom(south)
 *  4 = S-right(east)  5 = S-left(west)
 *  6 = W-bottom(south)7 = W-top(north)
 * The two half-edges of side k are (2k, 2k+1).
 */
export type HalfEdge = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface GridPos {
  x: number;
  y: number;
}
/** Map key helper: "x,y". */
export const posKey = (x: number, y: number): string => `${x},${y}`;

// ---- Tile definitions -----------------------------------------------------

export type EdgeType = "city" | "road" | "field" | "river";
export type FeatureKind = "city" | "road" | "cloister" | "field";

/**
 * A feature segment on a single tile, expressed in the tile's UNROTATED
 * frame (rotation 0).
 * - city/road: `edges` lists Side indices (0..3) this segment touches.
 * - field:     `edges` lists HalfEdge indices (0..7) this segment touches.
 * - cloister:  `edges` is empty.
 * `spot` is a 0..1 x/y position within the tile for drawing the meeple.
 * For fields, `adjacentCitySegments` lists indices (into the tile's `segments`)
 * of city segments this field borders (needed for farm scoring).
 */
export interface Segment {
  /** index within the owning tile's segments array; filled by tiles.ts */
  index: number;
  kind: FeatureKind;
  edges: number[];
  pennant?: boolean;
  spot: { x: number; y: number };
  /** for field segments only */
  adjacentCitySegments?: number[];
}

/** A tile TYPE definition (before placement/rotation). */
export interface TileDef {
  /** canonical letter id, e.g. "D" */
  id: string;
  /** how many of this tile are in the base deck */
  count: number;
  /** unrotated edge type per Side (index 0..3 = N,E,S,W). Derived from segments. */
  edges: [EdgeType, EdgeType, EdgeType, EdgeType];
  segments: Segment[];
}

// ---- Placed tiles & board -------------------------------------------------

/** rotation in 90° clockwise steps: 0,1,2,3 */
export type Rotation = 0 | 1 | 2 | 3;

export interface PlacedTile {
  def: TileDef;
  x: number;
  y: number;
  rotation: Rotation;
  /**
   * Meeple placed on this tile, if any.
   * `segmentIndex` refers to the UNROTATED segment index in def.segments.
   */
  meeple?: { playerId: number; segmentIndex: number };
}

// ---- Players & game state -------------------------------------------------

export type PlayerKind = "human" | "ai";

/** AI strength. "aggressive" plays to contest/steal the human's cities. */
export type Difficulty = "easy" | "normal" | "hard" | "aggressive";

export interface Player {
  id: number;
  name: string;
  color: string; // hex, for meeples & score UI
  kind: PlayerKind;
  score: number;
  meeplesLeft: number;
  /** per-AI strength (ai players only). */
  difficulty?: Difficulty;
}

export type Phase =
  | "placeTile" // current player must place the drawn tile
  | "placeMeeple" // tile placed; may place a meeple or skip
  | "scoring" // resolving completed features (animation)
  | "h&off" // pass-and-play hand-off screen
  | "gameOver";

export interface GameState {
  players: Player[];
  current: number; // index into players
  board: Map<string, PlacedTile>; // key = posKey
  deck: string[]; // remaining tile-type ids to draw
  drawn: TileDef | null; // current tile in hand
  drawnRotation: Rotation;
  phase: Phase;
  turn: number;
  passAndPlay: boolean; // if true, show hand-off screens
}

// ---- Engine interface (implemented in src/engine, consumed by ai/ui) ------

/** A legal position+rotation for the currently drawn tile. */
export interface LegalPlacement {
  x: number;
  y: number;
  rotation: Rotation;
}

/** A legal meeple spot after a tile has been placed at x,y,rotation. */
export interface LegalMeeple {
  segmentIndex: number; // unrotated segment index
  kind: FeatureKind;
}

/** Result of scoring one or more completed features (for animation/UI). */
export interface ScoreEvent {
  playerIds: number[]; // who scored (majority owners; may tie/share)
  points: number; // points awarded to EACH listed player
  kind: FeatureKind;
  /** board positions covered by the feature, for highlight animation */
  tiles: GridPos[];
  returnedMeeples: { playerId: number }[];
}

/**
 * The engine module (src/engine/index.ts) must export these functions.
 * Kept as a documented interface so ai/ui can code against it.
 */
export interface Engine {
  newGame(players: Player[], passAndPlay: boolean, seed?: number, river?: boolean): GameState;
  /** draw next tile into `drawn`; returns false if deck empty. */
  drawTile(g: GameState): boolean;
  /** all legal placements for the currently drawn tile. */
  legalPlacements(g: GameState): LegalPlacement[];
  /** place drawn tile; returns false if illegal. Advances phase to placeMeeple. */
  placeTile(g: GameState, x: number, y: number, rotation: Rotation): boolean;
  /** legal meeple spots for the just-placed tile. */
  legalMeeples(g: GameState): LegalMeeple[];
  /** place a meeple on the just-placed tile (or pass with segmentIndex=-1). */
  placeMeeple(g: GameState, segmentIndex: number): ScoreEvent[];
  /** end current turn: run completed-feature scoring, hand off / advance. */
  endTurn(g: GameState): ScoreEvent[];
  /** final scoring when deck is exhausted. */
  finalScore(g: GameState): ScoreEvent[];
}

// ---- Audio interface (src/audio) ------------------------------------------

export type SfxName =
  | "place"
  | "rotate"
  | "meeple"
  | "score"
  | "invalid"
  | "button"
  | "draw"
  | "victory"
  | "handoff"
  | "flip";

export interface AudioApi {
  init(): void; // must be called from a user gesture
  play(name: SfxName): void;
  startMusic(): void;
  stopMusic(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}
