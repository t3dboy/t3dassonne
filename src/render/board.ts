// ============================================================================
// T3dassonne — Board-level rendering helpers: scrolling grass background,
// camera math (world grid <-> screen), and legal-placement hints.
// ============================================================================

import { PALETTE } from "./palette";

/** Base on-screen size of one tile at scale = 1, in CSS pixels. */
export const BASE_TILE = 96;

/**
 * Camera describes the viewport over the infinite board.
 * offsetX/offsetY: world-pixel position (grid * BASE_TILE) that maps to the
 * top-left of the canvas. scale: zoom multiplier.
 */
export interface Camera {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** On-screen size of a tile at the current camera scale. */
export function tileScreenSize(cam: Camera): number {
  return BASE_TILE * cam.scale;
}

/** World pixel -> screen pixel. World pixels are gridCoord * BASE_TILE. */
export function worldToScreen(
  wx: number,
  wy: number,
  cam: Camera
): { x: number; y: number } {
  return {
    x: (wx - cam.offsetX) * cam.scale,
    y: (wy - cam.offsetY) * cam.scale,
  };
}

/** Screen pixel -> world pixel. */
export function screenToWorld(
  sx: number,
  sy: number,
  cam: Camera
): { x: number; y: number } {
  return {
    x: sx / cam.scale + cam.offsetX,
    y: sy / cam.scale + cam.offsetY,
  };
}

/** Grid cell -> screen top-left pixel. */
export function gridToScreen(
  gx: number,
  gy: number,
  cam: Camera
): { x: number; y: number } {
  return worldToScreen(gx * BASE_TILE, gy * BASE_TILE, cam);
}

/** Screen pixel -> grid cell (floored). */
export function screenToGrid(
  sx: number,
  sy: number,
  cam: Camera
): { gx: number; gy: number } {
  const w = screenToWorld(sx, sy, cam);
  return { gx: Math.floor(w.x / BASE_TILE), gy: Math.floor(w.y / BASE_TILE) };
}

// ---------------------------------------------------------------------------
// GRASS BACKGROUND  — a small pre-rendered tiling texture blitted across the
// viewport, scrolled by the camera so it feels like one continuous meadow.
// ---------------------------------------------------------------------------

const BG_TILE = 32; // texture cell size in low-res pixels
let bgPattern: HTMLCanvasElement | null = null;

function hashBg(x: number, y: number, s: number): number {
  let h = (x * 92837111 + y * 689287499 + s * 283923481) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return ((h * 2654435761) >>> 0) / 4294967295;
}

function buildBgPattern(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = BG_TILE;
  c.height = BG_TILE;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = PALETTE.grassDark;
  ctx.fillRect(0, 0, BG_TILE, BG_TILE);
  for (let y = 0; y < BG_TILE; y++) {
    for (let x = 0; x < BG_TILE; x++) {
      const r = hashBg(x, y, 1);
      if (r > 0.86) {
        ctx.fillStyle = PALETTE.grassDeep;
        ctx.fillRect(x, y, 1, 1);
      } else if (r < 0.06) {
        ctx.fillStyle = PALETTE.grassMid;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  // a few darker tufts so the meadow has some life under the board
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(hashBg(i, 5, 3) * (BG_TILE - 2)) + 1;
    const y = Math.floor(hashBg(i, 9, 4) * (BG_TILE - 2)) + 1;
    ctx.fillStyle = PALETTE.grassDeep;
    ctx.fillRect(x, y, 1, 2);
  }
  return c;
}

/**
 * Fill the whole (w×h) canvas with a scrolling pixel-grass texture that tracks
 * the camera. Call at the start of each frame before drawing tiles.
 */
export function drawGrassBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  camera: Camera
): void {
  if (!bgPattern) bgPattern = buildBgPattern();
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;

  // On-screen size of one background texture cell. Keep it chunky and tied to
  // scale so pixels stay crisp and the meadow parallax-scrolls with the board.
  const cell = Math.max(2, Math.round(BASE_TILE / 12)) * camera.scale;
  const scaledTile = cell * BG_TILE;

  // Scroll offset from camera (mod one texture span so we always cover screen).
  let ox = (-camera.offsetX * camera.scale) % scaledTile;
  let oy = (-camera.offsetY * camera.scale) % scaledTile;
  if (ox > 0) ox -= scaledTile;
  if (oy > 0) oy -= scaledTile;

  for (let y = oy; y < h; y += scaledTile) {
    for (let x = ox; x < w; x += scaledTile) {
      ctx.drawImage(bgPattern, 0, 0, BG_TILE, BG_TILE, Math.round(x), Math.round(y), Math.ceil(scaledTile), Math.ceil(scaledTile));
    }
  }
  ctx.imageSmoothingEnabled = prev;
}

/** Force the grass texture to rebuild (e.g. if the palette changes). */
export function clearBackgroundCache(): void {
  bgPattern = null;
}

// ---------------------------------------------------------------------------
// PLACEMENT HINT  — dashed golden square marking a legal empty cell.
// ---------------------------------------------------------------------------

/**
 * Draw a dashed golden square hint at screen (x,y) with side `size`.
 * Uses an animated-friendly static dash (caller can vary lineDashOffset via a
 * time param if desired by pushing/popping their own dash offset).
 */
export function drawPlacementHint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  dashOffset = 0
): void {
  ctx.save();
  // soft inner glow fill
  ctx.fillStyle = "rgba(242,193,78,0.12)";
  ctx.fillRect(x + 2, y + 2, size - 4, size - 4);

  ctx.strokeStyle = PALETTE.hintGold;
  ctx.lineWidth = Math.max(2, size * 0.03);
  const dash = Math.max(4, size * 0.09);
  ctx.setLineDash([dash, dash * 0.7]);
  ctx.lineDashOffset = dashOffset;
  ctx.lineJoin = "miter";
  const inset = ctx.lineWidth;
  ctx.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
  ctx.restore();
}
