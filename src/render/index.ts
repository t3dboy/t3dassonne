// ============================================================================
// T3dassonne — Public render API. Import from "./render" (this barrel).
// ============================================================================

// Palette & colour helpers
export { PALETTE, MEEPLE_COLORS, shade, tint } from "./palette";
export type { PaletteKey } from "./palette";

// Tile art
export {
  drawTile,
  clearTileCache,
  prewarmTile,
  computeMeepleSpot,
  TILE_BUFFER_RES,
} from "./tileArt";
export type { DrawTileOpts } from "./tileArt";

// Feature icons (score round-up)
export { featureIconCanvas, featureIconDataUrl } from "./icons";

// Meeples
export { drawMeeple, drawMeepleShadow } from "./meeple";
export { loadMeeple3D, meepleModelReady } from "./meeple3d";

// Board / camera / background / hints
export {
  BASE_TILE,
  tileScreenSize,
  worldToScreen,
  screenToWorld,
  gridToScreen,
  screenToGrid,
  drawGrassBackground,
  drawPlacementHint,
  clearBackgroundCache,
} from "./board";
export type { Camera } from "./board";
