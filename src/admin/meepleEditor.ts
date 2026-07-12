// ============================================================================
// Meeple Placement Editor (dev tool, /meeple-admin.html).
//
// Lets you hand-author where a meeple sits on each tile type per segment
// (farmer / road / knight / cloister), plus free-text notes per tile. Output is
// a JSON blob { overrides, notes } compatible with src/render/meepleOverrides.ts
// — copy it out and it gets applied to the game.
//
// Spots are authored in the UNROTATED (rotation-0) tile frame, normalized 0..1;
// computeMeepleSpot() rotates them for placed tiles.
// ============================================================================

import { TILE_DEFS } from "../core/tiles";
import type { FeatureKind, TileDef } from "../core/types";
import { drawTile, computeMeepleSpot, drawMeeple } from "../render";

interface Spot { x: number; y: number; }
interface TileEdit { notes: string; spots: Record<number, Spot>; }

const LS_KEY = "t3d-meeple-admin";
const TILE = 240;                 // on-screen tile size (px)
const KIND_COLOR: Record<FeatureKind, string> = {
  city: "#5b86b0", road: "#c07a34", field: "#46a552", cloister: "#9a6ad6",
};
const KIND_LABEL: Record<FeatureKind, string> = {
  city: "city", road: "road", field: "field", cloister: "abbey",
};

const store: Record<string, TileEdit> = load();
const activeSeg: Record<string, number> = {};   // tileId -> selected segment index
const cards: Record<string, () => void> = {};   // tileId -> re-render fn

function load(): Record<string, TileEdit> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}
function save(): void {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
  setStatus("Saved locally");
}
function edit(id: string): TileEdit {
  return (store[id] ||= { notes: "", spots: {} });
}
function setStatus(s: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = s;
}

/** Current spot for a segment: the override if set, else the algorithmic one. */
function spotFor(def: TileDef, seg: number): Spot {
  const ov = store[def.id]?.spots[seg];
  return ov ? ov : computeMeepleSpot(def, 0, seg);
}

function buildCard(def: TileDef): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";

  const totalCount = def.count ?? 0;
  const h2 = document.createElement("h2");
  h2.innerHTML = `Tile ${def.id} <span class="cnt">×${totalCount}</span>`;
  card.appendChild(h2);

  const wrap = document.createElement("div");
  wrap.className = "cv-wrap";
  const cv = document.createElement("canvas");
  cv.className = "tile";
  cv.width = TILE; cv.height = TILE;
  cv.style.width = TILE + "px"; cv.style.height = TILE + "px";
  wrap.appendChild(cv);
  card.appendChild(wrap);
  const ctx = cv.getContext("2d")!;

  if (activeSeg[def.id] === undefined) activeSeg[def.id] = def.segments[0]?.index ?? 0;

  // --- segment chips ---
  const segs = document.createElement("div");
  segs.className = "segs";
  card.appendChild(segs);

  // --- notes ---
  const notes = document.createElement("textarea");
  notes.placeholder = "Notes for this tile (e.g. 'farmer sits too high on the S field')…";
  notes.value = store[def.id]?.notes ?? "";
  notes.addEventListener("input", () => { edit(def.id).notes = notes.value; save(); });
  card.appendChild(notes);

  // --- reset row ---
  const row = document.createElement("div");
  row.className = "row";
  const rSeg = document.createElement("button");
  rSeg.textContent = "Reset segment";
  rSeg.addEventListener("click", () => {
    const s = activeSeg[def.id];
    if (store[def.id]) { delete store[def.id].spots[s]; save(); }
    render();
  });
  const rTile = document.createElement("button");
  rTile.textContent = "Reset tile spots";
  rTile.addEventListener("click", () => {
    if (store[def.id]) { store[def.id].spots = {}; save(); }
    render();
  });
  row.append(rSeg, rTile);
  card.appendChild(row);

  function render(): void {
    // tile art
    ctx.clearRect(0, 0, TILE, TILE);
    drawTile(ctx, def, 0, 0, 0, TILE);
    // quarter grid
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath(); ctx.moveTo(f * TILE, 0); ctx.lineTo(f * TILE, TILE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, f * TILE); ctx.lineTo(TILE, f * TILE); ctx.stroke();
    }
    // markers (meeple silhouette per segment, tinted by kind)
    for (const seg of def.segments) {
      const sp = spotFor(def, seg.index);
      const cx = sp.x * TILE, cy = sp.y * TILE;
      const isActive = seg.index === activeSeg[def.id];
      if (isActive) {
        ctx.beginPath();
        ctx.arc(cx, cy, 22, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(242,201,78,0.22)";
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#f2c94e"; ctx.stroke();
      }
      drawMeeple(ctx, cx, cy, isActive ? 34 : 26, KIND_COLOR[seg.kind], false);
    }

    // chips
    segs.innerHTML = "";
    for (const seg of def.segments) {
      const chip = document.createElement("div");
      chip.className = "seg" + (seg.index === activeSeg[def.id] ? " active" : "");
      const overridden = !!store[def.id]?.spots[seg.index];
      chip.innerHTML =
        `<span class="dot" style="background:${KIND_COLOR[seg.kind]}"></span>` +
        `${seg.index} ${KIND_LABEL[seg.kind]}` +
        (overridden ? ` <span class="ov">●</span>` : "");
      chip.addEventListener("click", () => { activeSeg[def.id] = seg.index; render(); });
      segs.appendChild(chip);
    }
  }
  cards[def.id] = render;

  // --- pointer: click/drag to place the active segment's spot ---
  let dragging = false;
  const toNorm = (e: PointerEvent): Spot => {
    const r = cv.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const apply = (p: Spot) => {
    edit(def.id).spots[activeSeg[def.id]] = { x: round(p.x), y: round(p.y) };
    render();
  };
  cv.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = toNorm(e);
    // if the click lands near another segment's marker, select it instead of moving
    let pick = -1, best = 20 / TILE;
    for (const seg of def.segments) {
      const sp = spotFor(def, seg.index);
      const d = Math.hypot(sp.x - p.x, sp.y - p.y);
      if (seg.index !== activeSeg[def.id] && d < best) { best = d; pick = seg.index; }
    }
    if (pick >= 0) { activeSeg[def.id] = pick; render(); }
    dragging = true;
    apply(p);
  });
  cv.addEventListener("pointermove", (e) => { if (dragging) apply(toNorm(e)); });
  const end = (e: PointerEvent) => { if (dragging) { dragging = false; save(); try { cv.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);

  render();
  return card;
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

function exportJson(): string {
  const overrides: Record<string, Record<string, Spot>> = {};
  const notes: Record<string, string> = {};
  for (const id of Object.keys(TILE_DEFS)) {
    const e = store[id];
    if (!e) continue;
    if (Object.keys(e.spots).length) {
      overrides[id] = {};
      for (const k of Object.keys(e.spots)) overrides[id][k] = e.spots[+k];
    }
    if (e.notes.trim()) notes[id] = e.notes.trim();
  }
  return JSON.stringify({ overrides, notes }, null, 2);
}

function importJson(text: string): void {
  const data = JSON.parse(text);
  const ov = data.overrides || {};
  const nt = data.notes || {};
  for (const id of Object.keys(TILE_DEFS)) {
    const spots: Record<number, Spot> = {};
    if (ov[id]) for (const k of Object.keys(ov[id])) spots[+k] = ov[id][k];
    const notes = typeof nt[id] === "string" ? nt[id] : "";
    if (Object.keys(spots).length || notes) store[id] = { notes, spots };
  }
  save();
}

function main(): void {
  const grid = document.getElementById("grid")!;
  for (const id of Object.keys(TILE_DEFS)) grid.appendChild(buildCard(TILE_DEFS[id]));

  document.getElementById("copy")!.addEventListener("click", async () => {
    const json = exportJson();
    try { await navigator.clipboard.writeText(json); setStatus("Copied JSON to clipboard"); }
    catch { window.prompt("Copy the JSON:", json); }
  });
  document.getElementById("download")!.addEventListener("click", () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "meeple-placements.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Downloaded");
  });
  document.getElementById("import")!.addEventListener("click", () => {
    const text = window.prompt("Paste meeple-placements JSON:");
    if (!text) return;
    try { importJson(text); rerenderAll(); setStatus("Imported"); }
    catch (err) { setStatus("Import failed: " + (err as Error).message); }
  });
  document.getElementById("resetAll")!.addEventListener("click", () => {
    if (!window.confirm("Clear ALL meeple placements and notes?")) return;
    for (const k of Object.keys(store)) delete store[k];
    save(); rerenderAll(); setStatus("Cleared");
  });
  setStatus(Object.keys(store).length ? "Loaded saved edits" : "Ready");
}

function rerenderAll(): void {
  // rebuild cards from scratch so notes textareas & chips reflect imported state
  const grid = document.getElementById("grid")!;
  grid.innerHTML = "";
  for (const id of Object.keys(TILE_DEFS)) grid.appendChild(buildCard(TILE_DEFS[id]));
}

main();
