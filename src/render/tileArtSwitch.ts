// ============================================================================
// Tile-renderer selector. Lets us ship BOTH the current painterly renderer and
// the experimental Celeste pixel renderer in one build, choosing between them at
// page-load time via a `?pixel` URL flag (or localStorage `t3d-style=pixel`).
//
// Default is the existing painterly style, so the live site is unchanged. Open
// the game with `?pixel` to preview the pixel style. The choice is fixed for the
// session (read once here) so the per-tile caches inside each renderer stay
// coherent — no mid-session switching.
// ============================================================================

import * as painterly from "./tileArt";
import * as pixel from "./tileArt.pixel";

export type { DrawTileOpts } from "./tileArt";

export function pixelStyleActive(): boolean {
  if (typeof location === "undefined") return false;
  try {
    if (new URLSearchParams(location.search).has("pixel")) return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("t3d-style") === "pixel") return true;
  } catch {
    /* SSR / restricted context — fall back to default */
  }
  return false;
}

const R = pixelStyleActive() ? pixel : painterly;

export const drawTile = R.drawTile;
export const computeMeepleSpot = R.computeMeepleSpot;
export const clearTileCache = R.clearTileCache;
export const prewarmTile = R.prewarmTile;
export const TILE_BUFFER_RES = R.TILE_BUFFER_RES;
