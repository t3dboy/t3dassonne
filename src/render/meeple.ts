// ============================================================================
// T3dassonne — Meeple rendering. Classic Carcassonne silhouette (head + body
// with outstretched arms + legs) drawn in chunky pixel style with a dark
// outline, using per-player fill colours from the palette.
// ============================================================================

import { PALETTE, shade } from "./palette";
import { getMeepleSprite } from "./meeple3d";

/**
 * Classic meeple silhouette normalised to a unit box. Each entry is a
 * horizontal run [rowY, xStart, xEnd] in 0..1 coords. Rows are 0 (top) to 1.
 * We describe it as filled cells on a 10x12 grid, then scale to `size`.
 */
// 10 wide x 12 tall grid. 1 = filled.
const GRID_W = 10;
const GRID_H = 12;
// prettier-ignore
const MEEPLE_MASK: number[] = [
  0,0,0,1,1,1,0,0,0,0, // head top
  0,0,1,1,1,1,1,0,0,0, // head
  0,0,1,1,1,1,1,0,0,0, // head
  1,1,1,1,1,1,1,1,1,0, // arms out (shoulders)
  1,1,1,1,1,1,1,1,1,0, // arms
  0,1,1,1,1,1,1,1,0,0, // upper body
  0,0,1,1,1,1,1,0,0,0, // waist
  0,0,1,1,1,1,1,0,0,0, // hips
  0,0,1,1,0,1,1,0,0,0, // legs split
  0,0,1,1,0,1,1,0,0,0, // legs
  0,0,1,1,0,1,1,0,0,0, // legs
  0,1,1,1,0,1,1,1,0,0, // feet
];

/**
 * Draw a meeple centred at (cx,cy). `size` is the meeple's bounding height in
 * screen pixels (~0.4 * tile). `color` = fill hex (see MEEPLE_COLORS).
 */
export function drawMeeple(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  laying = false
): void {
  // Prefer the 3D model sprite when it has loaded; else the pixel silhouette.
  const sprite = getMeepleSprite(color, laying);
  if (sprite) {
    const box = size * 1.19; // sprite has margin; ~30% smaller than before
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sprite, cx - box / 2, cy - box / 2, box, box);
    ctx.imageSmoothingEnabled = prev;
    return;
  }
  if (laying) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 2);
    drawSilhouette(ctx, 0, 0, size, color);
    ctx.restore();
    return;
  }
  drawSilhouette(ctx, cx, cy, size, color);
}

/** The chunky pixel-art meeple silhouette (fallback before the 3D model loads). */
function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  const cell = Math.max(1, size / GRID_H);
  const w = GRID_W * cell;
  const h = GRID_H * cell;
  const ox = cx - w / 2;
  const oy = cy - h / 2;
  const dark = shade(color, 0.68);

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;

  const isFilled = (gx: number, gy: number): boolean => {
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
    return MEEPLE_MASK[gy * GRID_W + gx] === 1;
  };

  // 1. outline pass: draw dark cell wherever a filled cell has an empty
  //    orthogonal neighbour, plus a 1-cell drop skirt for chunkiness.
  ctx.fillStyle = PALETTE.outline;
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      if (!isFilled(gx, gy)) continue;
      const neighbors = [
        [gx - 1, gy],
        [gx + 1, gy],
        [gx, gy - 1],
        [gx, gy + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (!isFilled(nx, ny)) {
          ctx.fillRect(
            Math.floor(ox + nx * cell),
            Math.floor(oy + ny * cell),
            Math.ceil(cell),
            Math.ceil(cell)
          );
        }
      }
    }
  }

  // 2. body fill
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      if (!isFilled(gx, gy)) continue;
      // lower half shaded for a touch of depth
      ctx.fillStyle = gy >= 8 ? dark : color;
      ctx.fillRect(
        Math.floor(ox + gx * cell),
        Math.floor(oy + gy * cell),
        Math.ceil(cell),
        Math.ceil(cell)
      );
    }
  }

  // 3. tiny highlight on the head for that Stardew glossy look
  ctx.fillStyle = PALETTE.flowerWhite;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(Math.floor(ox + 3 * cell), Math.floor(oy + 1 * cell), Math.ceil(cell), Math.ceil(cell));
  ctx.globalAlpha = 1;

  ctx.imageSmoothingEnabled = prev;
}

/** Soft elliptical drop shadow to seat a meeple on the tile. Draw BEFORE the meeple. */
export function drawMeepleShadow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number
): void {
  ctx.save();
  ctx.fillStyle = PALETTE.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.42, size * 0.34, size * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
