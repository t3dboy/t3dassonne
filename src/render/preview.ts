// ============================================================================
// T3dassonne — Art preview page. Renders all 24 tile types at several
// rotations, plus a meeple colour row and a demo of ghost/highlight states.
// Load via art-preview.html. Not part of the game runtime.
// ============================================================================

import { TILE_DEFS } from "../core/tiles";
import type { Rotation } from "../core/types";
import {
  BASE_TILE,
  Camera,
  drawGrassBackground,
  drawMeeple,
  drawMeepleShadow,
  drawPlacementHint,
  drawTile,
  MEEPLE_COLORS,
  PALETTE,
} from "./index";

const app = document.getElementById("app")!;

const TILE = 96; // preview draw size (== BASE_TILE)
const GAP = 26;
const LABEL_H = 20;
const ROTS: Rotation[] = [0, 1, 2, 3];

function section(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  h.style.cssText =
    "font:700 15px system-ui;color:#f4e9c8;margin:26px 0 10px;letter-spacing:.5px";
  app.appendChild(h);
  return h;
}

function subtle(text: string): void {
  const p = document.createElement("p");
  p.textContent = text;
  p.style.cssText = "font:12px system-ui;color:#c8b48c;margin:0 0 14px";
  app.appendChild(p);
}

function makeCanvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = w + "px";
  c.style.height = h + "px";
  c.style.display = "block";
  c.style.borderRadius = "6px";
  app.appendChild(c);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

// ---- All tiles, each at 4 rotations ---------------------------------------
section("All 24 tile types — each shown at rotations 0 / 90 / 180 / 270");
subtle(
  "Grass fields, brown dirt roads, terracotta-roof stone cities (blue/gold pennants where present), and centre chapels for cloisters. Pixel-art at " +
    TILE +
    "px (BASE_TILE)."
);

{
  const ids = Object.keys(TILE_DEFS); // A..X in insertion order
  const cols = ROTS.length;
  const cellW = TILE + GAP;
  const cellH = TILE + LABEL_H + GAP;
  const rowsLabelW = 34;
  const W = rowsLabelW + cols * cellW;
  const H = ids.length * cellH + 10;
  const ctx = makeCanvas(W, H);

  ids.forEach((id, row) => {
    const def = TILE_DEFS[id];
    const y0 = row * cellH;
    // row label (tile id)
    ctx.fillStyle = "#f4e9c8";
    ctx.font = "700 16px system-ui";
    ctx.textBaseline = "middle";
    ctx.fillText(id, 8, y0 + TILE / 2);

    ROTS.forEach((rot, col) => {
      const x = rowsLabelW + col * cellW;
      const y = y0;
      // subtle drop shadow behind each tile
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x + 3, y + 4, TILE, TILE);
      drawTile(ctx, def, rot, x, y, TILE);
      // per-rotation label
      ctx.fillStyle = "#a99a72";
      ctx.font = "11px system-ui";
      ctx.textBaseline = "top";
      ctx.fillText(`${id} · ${rot * 90}°`, x, y + TILE + 4);
    });
  });
}

// ---- Meeple colour row ----------------------------------------------------
section("Meeple colours — 5 players");
subtle("Classic Carcassonne silhouette with soft shadow, per-player fill.");
{
  const M = 72;
  const cellW = M + 24;
  const W = MEEPLE_COLORS.length * cellW + 10;
  const H = M + 30;
  const ctx = makeCanvas(W, H);
  // grassy strip so meeples read against a tile-like ground
  const cam: Camera = { offsetX: 0, offsetY: 0, scale: 1 };
  drawGrassBackground(ctx, W, H, cam);
  MEEPLE_COLORS.forEach((color, i) => {
    const cx = i * cellW + cellW / 2 - 12;
    const cy = M / 2 + 4;
    drawMeepleShadow(ctx, cx, cy, M * 0.62);
    drawMeeple(ctx, cx, cy, M * 0.62, color);
    ctx.fillStyle = "#e9dcb8";
    ctx.font = "11px system-ui";
    ctx.textBaseline = "top";
    ctx.fillText(`P${i + 1}`, cx - 8, M + 8);
  });
}

// ---- States demo: normal / ghost / highlight, + placement hint + meeple ---
section("States — ghost preview · completed-feature highlight · placement hint · meeple on tile");
{
  const demoIds = ["D", "O", "S", "A", "X"];
  const cellW = TILE + GAP;
  const W = demoIds.length * cellW + 10;
  const H = TILE + 40;
  const ctx = makeCanvas(W, H);
  const cam: Camera = { offsetX: 0, offsetY: 0, scale: 1 };
  drawGrassBackground(ctx, W, H, cam);

  demoIds.forEach((id, i) => {
    const def = TILE_DEFS[id];
    const x = i * cellW;
    const y = 6;
    if (i === 0) {
      drawTile(ctx, def, 0, x, y, TILE, { ghost: true });
      label(ctx, x, y, "ghost");
    } else if (i === 1) {
      drawTile(ctx, def, 1, x, y, TILE, { highlight: true });
      label(ctx, x, y, "highlight");
    } else if (i === 2) {
      drawTile(ctx, def, 2, x, y, TILE);
      // meeple on the city
      const mcx = x + TILE * 0.5;
      const mcy = y + TILE * 0.35;
      drawMeepleShadow(ctx, mcx, mcy, TILE * 0.34);
      drawMeeple(ctx, mcx, mcy, TILE * 0.34, MEEPLE_COLORS[0]);
      label(ctx, x, y, "meeple");
    } else if (i === 3) {
      drawTile(ctx, def, 0, x, y, TILE);
      const mcx = x + TILE * 0.5;
      const mcy = y + TILE * 0.5;
      drawMeepleShadow(ctx, mcx, mcy, TILE * 0.34);
      drawMeeple(ctx, mcx, mcy, TILE * 0.34, MEEPLE_COLORS[3]);
      label(ctx, x, y, "cloister+meeple");
    } else {
      drawPlacementHint(ctx, x, y, TILE);
      label(ctx, x, y, "hint");
    }
  });

  function label(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    t: string
  ): void {
    c.fillStyle = "#e9dcb8";
    c.font = "11px system-ui";
    c.textBaseline = "top";
    c.fillText(t, x, y + TILE + 4);
  }
}

// ---- Mini board mock: a few tiles laid on the scrolling grass -------------
section("Mini board — tiles on scrolling grass background with camera");
{
  const W = 5 * BASE_TILE;
  const H = 3 * BASE_TILE;
  const ctx = makeCanvas(W, H);
  const cam: Camera = { offsetX: -20, offsetY: -14, scale: 1 };
  drawGrassBackground(ctx, W, H, cam);
  const layout: [string, Rotation, number, number][] = [
    ["D", 0, 0, 1],
    ["U", 0, 1, 1],
    ["V", 3, 2, 1],
    ["N", 1, 2, 0],
    ["A", 0, 3, 1],
    ["S", 0, 1, 0],
    ["X", 0, 3, 0],
  ];
  for (const [id, rot, gx, gy] of layout) {
    const sx = gx * BASE_TILE - cam.offsetX;
    const sy = gy * BASE_TILE - cam.offsetY;
    ctx.fillStyle = PALETTE.shadow;
    ctx.fillRect(sx + 3, sy + 4, BASE_TILE, BASE_TILE);
    drawTile(ctx, TILE_DEFS[id], rot, sx, sy, BASE_TILE);
  }
}
