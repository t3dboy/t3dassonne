// ============================================================================
// T3dassonne — Public render API. Import from "./render" (this barrel).
// ============================================================================

// Palette & colour helpers
export { PALETTE, MEEPLE_COLORS, shade, tint } from "./palette";
export type { PaletteKey } from "./palette";

// Tile art — dispatched through the style switch (painterly by default,
// Celeste pixel style when the `?pixel` flag is set).
export {
  drawTile,
  clearTileCache,
  prewarmTile,
  computeMeepleSpot,
  TILE_BUFFER_RES,
  pixelStyleActive,
} from "./tileArtSwitch";
export type { DrawTileOpts } from "./tileArtSwitch";

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
