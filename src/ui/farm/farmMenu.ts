// ============================================================================
// Farming canvas MENU (opt-in via ?farmui). Renders the animated dusk
// title screen — VS COMPUTER / PASS & PLAY, player count, river + table-flip
// toggles — plus a per-AI difficulty sub-screen reached from VS COMPUTER.
//
// Sizing: logical HEIGHT is fixed (so the content always fits vertically) and
// logical WIDTH tracks the true viewport aspect, so scaling the buffer to fill
// the screen is always uniform — it never distorts.
// ============================================================================

import { type PixBuf, drawText, textWidth } from "./pixelfont";
import * as UI from "./uiscene";
import type { Difficulty } from "../../ai";
import { openGuide } from "../guide";
import { safeAreaTop } from "../dom";

const R = UI.RGBP;
const LH = 380;        // fixed logical height (enough for all the content)
const MIN_W = 176;     // narrowest logical width (keeps the panel usable)
const MAX_PANEL = 190; // panels never grow wider than this (centred on wide screens)

const DIFFS: Difficulty[] = ["easy", "normal", "hard", "aggressive"];
const DLABEL: Record<Difficulty, string> = { easy: "EASY", normal: "MEDIUM", hard: "HARD", aggressive: "AGGRO" };
const diffOpts = (d: Difficulty): UI.BtnOpts =>
  d === "easy" ? { teal: true } : d === "normal" ? { gold: true } : d === "aggressive" ? { red: true } : {};

export interface FarmMenuCallbacks {
  start(mode: "ai" | "pass", players: number, river: boolean, tableFlip: boolean, difficulties: Difficulty[]): void;
}

interface Hit { id: string; x: number; y: number; w: number; h: number; }
interface MenuState {
  screen: "main" | "diff";
  players: number;
  river: boolean;
  tableFlip: boolean;
  aiDiff: Difficulty[]; // per-AI (index 0 = AI 1); length 4
  pressed: string | null;
}

function header(b: PixBuf, W: number, inset: number): void {
  const pw = Math.min(W - 16, MAX_PANEL), cx = Math.round((W - pw) / 2);
  UI.panel(b, cx, 16 + inset, pw, 32);
  const title = "T3DASSONNE", tw = textWidth(title, 2, 1);
  drawText(b, title, Math.round((W - tw) / 2), 25 + inset, R.panelWoodDk, 2, 1, null);
  drawText(b, title, Math.round((W - tw) / 2) - 1, 24 + inset, R.gold, 2, 1, null);
}

function drawMain(b: PixBuf, state: MenuState, inset: number): Hit[] {
  const W = b.w, H = b.h, hits: Hit[] = [];
  const pw = Math.min(W - 16, MAX_PANEL);
  const cx = Math.round((W - pw) / 2);
  const ix = cx + 10, iw = pw - 20;

  // "How to play" guide button, tucked below the title sign
  const gw = 100, gx = Math.round((W - gw) / 2), gy = 54 + inset;
  UI.button(b, gx, gy, gw, 20, "? HOW TO PLAY", { teal: true, scale: 1, pressed: state.pressed === "guide" });
  hits.push({ id: "guide", x: gx, y: gy, w: gw, h: 20 });

  const ph = 150, py = H - ph - 20;
  UI.panel(b, cx, py, pw, ph);
  UI.button(b, ix, py + 10, iw, 26, "VS COMPUTER", { gold: true, scale: 2, pressed: state.pressed === "vs" });
  hits.push({ id: "vs", x: ix, y: py + 10, w: iw, h: 26 });
  // PASS & PLAY — with a compact table-flip toggle beside it, shown only for
  // 2-player (the case where flat-on-a-table play makes sense).
  const twoP = state.players === 2;
  const flipW = 26, ppW = twoP ? iw - flipW - 4 : iw;
  const ppLabel = twoP ? "PASS&PLAY" : "PASS & PLAY";
  UI.button(b, ix, py + 40, ppW, 26, ppLabel, { scale: 2, pressed: state.pressed === "pp" });
  hits.push({ id: "pp", x: ix, y: py + 40, w: ppW, h: 26 });
  if (twoP) {
    const fx = ix + iw - flipW;
    UI.button(b, fx, py + 40, flipW, 26, "⇅", { teal: state.tableFlip, scale: 2, pressed: state.pressed === "tf" });
    hits.push({ id: "tf", x: fx, y: py + 40, w: flipW, h: 26 });
  }
  drawText(b, "PLAYERS", ix + 2, py + 74, R.ink, 1, 1, null);
  const bw = 26, gap = Math.max(6, Math.floor((iw - 4 * bw) / 3));
  const total = 4 * bw + 3 * gap, psx = cx + Math.round((pw - total) / 2);
  ["2", "3", "4", "5"].forEach((n, i) => {
    const x = psx + i * (bw + gap);
    UI.button(b, x, py + 84, bw, 22, n, { scale: 2, sel: state.players === +n, pressed: state.pressed === "p" + n });
    hits.push({ id: "p" + n, x, y: py + 84, w: bw, h: 22 });
  });
  UI.button(b, ix, py + 114, iw, 22, state.river ? "RIVER: ON" : "RIVER: OFF", { teal: state.river, scale: 1, pressed: state.pressed === "rv" });
  hits.push({ id: "rv", x: ix, y: py + 114, w: iw, h: 22 });
  return hits;
}

function drawDiff(b: PixBuf, state: MenuState): Hit[] {
  const W = b.w, H = b.h, hits: Hit[] = [];
  const pw = Math.min(W - 16, MAX_PANEL);
  const cx = Math.round((W - pw) / 2);
  const ix = cx + 10, iw = pw - 20;
  const nAI = state.players - 1;

  const ph = nAI * 30 + 100, py = H - ph - 20;
  UI.panel(b, cx, py, pw, ph);
  const hdr = "AI DIFFICULTY", hw = textWidth(hdr, 1, 1);
  drawText(b, hdr, Math.round((W - hw) / 2), py + 8, R.panelWoodDk, 1, 1, null);
  const hint = "TAP TO CYCLE", hnw = textWidth(hint, 1, 1);
  drawText(b, hint, Math.round((W - hnw) / 2), py + 18, R.ink, 1, 1, null);

  for (let i = 0; i < nAI; i++) {
    const y = py + 30 + i * 30;
    const d = state.aiDiff[i] ?? "normal";
    UI.button(b, ix, y, iw, 24, `AI ${i + 1}: ${DLABEL[d]}`, { ...diffOpts(d), scale: 1, pressed: state.pressed === "d" + i });
    hits.push({ id: "d" + i, x: ix, y, w: iw, h: 24 });
  }

  const sy = py + 30 + nAI * 30 + 4;
  UI.button(b, ix, sy, iw, 26, "START", { gold: true, scale: 2, pressed: state.pressed === "start" });
  hits.push({ id: "start", x: ix, y: sy, w: iw, h: 26 });
  UI.button(b, ix, sy + 32, iw, 20, "BACK", { scale: 1, pressed: state.pressed === "back" });
  hits.push({ id: "back", x: ix, y: sy + 32, w: iw, h: 20 });
  return hits;
}

function draw(b: PixBuf, t: number, state: MenuState): Hit[] {
  const W = b.w, H = b.h;
  UI.drawBackground(b, t);
  for (let i = 0; i < W * H; i++) { const j = i * 4; b.data[j] *= 0.9; b.data[j + 1] *= 0.9; b.data[j + 2] *= 0.94; }
  // drop the top content below the iPhone status bar / Dynamic Island
  const inset = Math.round(safeAreaTop() * H / Math.max(1, window.innerHeight));
  header(b, W, inset);
  const hits = state.screen === "diff" ? drawDiff(b, state) : drawMain(b, state, inset);
  if (state.screen === "main") {
    const hint = "TAP TO PLAY";
    if (0.5 + 0.5 * Math.sin(t * 3) > 0.35) drawText(b, hint, Math.round((W - textWidth(hint, 1, 1)) / 2), H - 14, R.white, 1, 1, [10, 8, 16]);
  }
  return hits;
}

/** Mount the animated farm menu into `host`. Returns an unmount function. */
export function mountFarmMenu(host: HTMLElement, cb: FarmMenuCallbacks): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "farmui";
  const ctx = canvas.getContext("2d")!;
  let W = calcW();
  let buf: PixBuf = { w: W, h: LH, data: new Uint8ClampedArray(W * LH * 4) };
  let img: ImageData;

  function calcW(): number {
    return Math.max(MIN_W, Math.round(LH * window.innerWidth / Math.max(1, window.innerHeight)));
  }
  function resize(): void {
    W = calcW();
    canvas.width = W; canvas.height = LH;
    ctx.imageSmoothingEnabled = false;
    buf = { w: W, h: LH, data: new Uint8ClampedArray(W * LH * 4) };
    img = ctx.createImageData(W, LH);
  }
  resize();
  host.appendChild(canvas);

  const state: MenuState = {
    screen: "main", players: 2, river: false, tableFlip: true,
    aiDiff: ["normal", "normal", "normal", "normal"], pressed: null,
  };
  let hits: Hit[] = [];

  const logical = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (LH / r.height) };
  };
  const hitAt = (p: { x: number; y: number }): Hit | null => {
    for (const h of hits) if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return h;
    return null;
  };
  const onDown = (e: PointerEvent) => { const h = hitAt(logical(e)); if (h) state.pressed = h.id; };
  const onUp = () => {
    if (!state.pressed) return;
    const id = state.pressed; state.pressed = null;
    if (state.screen === "main") {
      if (id === "vs") state.screen = "diff";
      else if (id === "pp") cb.start("pass", state.players, state.river, state.players === 2 && state.tableFlip, []);
      else if (id === "guide") openGuide();
      else if (id[0] === "p" && id.length === 2) state.players = +id[1];
      else if (id === "rv") state.river = !state.river;
      else if (id === "tf") state.tableFlip = !state.tableFlip;
    } else {
      if (id === "back") state.screen = "main";
      else if (id === "start") cb.start("ai", state.players, state.river, false, state.aiDiff.slice(0, state.players - 1));
      else if (id[0] === "d") {
        const i = +id.slice(1);
        const cur = DIFFS.indexOf(state.aiDiff[i] ?? "normal");
        state.aiDiff[i] = DIFFS[(cur + 1) % DIFFS.length];
      }
    }
  };
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("resize", resize);

  let raf = 0, running = true;
  const frame = (now: number) => {
    if (!running) return;
    hits = draw(buf, now / 1000, state);
    img.data.set(buf.data);
    ctx.putImageData(img, 0, 0);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };
}
