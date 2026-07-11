// ============================================================================
// T3dassonne — app controller: screens, board render, input, turn loop.
// ============================================================================
import "./ui/style.css";
import type { GameState, Player, ScoreEvent, LegalPlacement, Rotation } from "./core/types";
import { posKey } from "./core/types";
import { engine, cloneState } from "./engine";
import { drawTile, drawMeeple, BASE_TILE, computeMeepleSpot, loadMeeple3D, meepleModelReady, featureIconCanvas, featureIconDataUrl } from "./render";
import { audio } from "./audio";
import { chooseTurn } from "./ai";
import {
  showMenu,
  showSetup,
  showHandoff,
  showGameOver,
  type MatchConfig,
  type Mode,
  type FinalResult,
} from "./ui/screens";
import { el, button, clear } from "./ui/dom";

// ---- root DOM --------------------------------------------------------------
const app = document.getElementById("app")!;
const canvas = el("canvas", { id: "board" }) as HTMLCanvasElement;
const overlay = el("div", { id: "overlay" });
app.append(canvas, overlay);
const ctx = canvas.getContext("2d")!;

let W = 0,
  H = 0,
  DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
}
window.addEventListener("resize", resize);
resize();

// ---- camera ----------------------------------------------------------------
const cam = { x: 0, y: 0, scale: 1.05 };
const tileSize = () => BASE_TILE * cam.scale;
const cellTopLeft = (gx: number, gy: number): [number, number] => [
  cam.x + gx * tileSize(),
  cam.y + gy * tileSize(),
];
/** "#rrggbb" → "r,g,b" for building rgba() strings with a runtime alpha. */
function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
const screenToCell = (sx: number, sy: number): [number, number] => [
  Math.floor((sx - cam.x) / tileSize()),
  Math.floor((sy - cam.y) / tileSize()),
];
function centerOn(gx: number, gy: number) {
  const ts = tileSize();
  cam.x = W / 2 - (gx + 0.5) * ts;
  cam.y = H / 2 - (gy + 0.5) * ts;
}
/** Smoothly pan the camera to centre grid cell (gx,gy). */
function panTo(gx: number, gy: number) {
  const ts = tileSize();
  panTarget = { x: W / 2 - (gx + 0.5) * ts, y: H / 2 - (gy + 0.5) * ts };
}

// ---- app state -------------------------------------------------------------
type AppMode = "menu" | "setup" | "game" | "scoring" | "gameover";
let appMode: AppMode = "menu";
let g: GameState | null = null;
let config: MatchConfig | null = null;
let legal: LegalPlacement[] = []; // legal placements for current drawn tile
let legalMeepleSpots: { seg: number; x: number; y: number }[] = []; // screen-space (recomputed each frame)
let busy = false; // AI / animations in progress; block human input
let awaitingHandoff = false;
// Tentative tile placement: the human drops the tile here, may rotate/move it,
// and only commits on the ✓ confirm button. null = nothing dropped yet.
let pendingCell: { x: number; y: number } | null = null;
// Tentative meeple selection (segment index) — committed on ✓. null = none.
let pendingMeeple: number | null = null;
// The previous move, outlined subtly in the placer's colour.
let lastMove: { x: number; y: number; playerId: number } | null = null;
// Smooth camera pan target (cam.x/cam.y). Cleared when the user pans manually.
let panTarget: { x: number; y: number } | null = null;
// Final guided-scoring state.
let highlightTiles: { x: number; y: number }[] | null = null;
let highlightColor = "#ffd76b"; // colour of the player currently being tallied
let scorePopup: { x: number; y: number; points: number; color: string; kind: string; born: number } | null = null;
let displayScores: number[] = [];
let scoringEvents: ScoreEvent[] = [];
let scoringIndex = 0;
// Every point-scoring event this game — drawn as who-scored-what badges at the end.
let allScoreEvents: ScoreEvent[] = [];
// Tile "fly to the table" placement animation.
let tileAnim: {
  def: import("./core/types").TileDef;
  rot: Rotation;
  x: number;
  y: number;
  from: { x: number; y: number };
  fromSize: number;
  born: number;
  dur: number;
} | null = null;

// toasts / banners
const toasts: { text: string; born: number; color: string }[] = [];
function toast(text: string, color = "#3a2a1a") {
  toasts.push({ text, born: performance.now(), color });
}

// ---- screen flow -----------------------------------------------------------
function gotoMenu() {
  appMode = "menu";
  g = null;
  audio.stopMusic(); // leaving a game must silence the looping music
  hud.classList.add("hidden");
  showMenu(overlay, { onPlay: (m) => gotoSetup(m) });
}
function gotoSetup(mode: Mode) {
  appMode = "setup";
  showSetup(overlay, mode, {
    onStart: (m) => startMatch(m),
    onBack: () => gotoMenu(),
  });
}

// ---- HUD -------------------------------------------------------------------
const hud = el("div", { class: "hud hidden" });
overlay.append(hud);
const scoresEl = el("div", { class: "scores" });
const handCanvas = el("canvas", { class: "handtile" }) as HTMLCanvasElement;
handCanvas.width = 168;
handCanvas.height = 168;
const promptEl = el("div", { class: "prompt" }, ["…"]);
// subtle on-tile rotate affordance (transparent, tile-sized; positioned each frame)
const rotIcon = el("span", { class: "rico" }, ["⟳"]);
const rotRing = el("span", { class: "rring" });
const rotateBtn = el("button", { class: "rotatebtn hidden" }, [rotRing, rotIcon]);
let rotSpin = 0;
rotateBtn.addEventListener("click", (e) => {
  e.preventDefault();
  rotateDrawn();
});
const menuBtn = button("☰", () => confirmQuit(), "iconbtn");
const muteBtn = button(audio.isMuted() ? "🔇" : "🔊", () => toggleMute(), "iconbtn");
const confirmBtn = button("✓", () => onConfirm(), "confirmbtn");
const tileCountEl = el("div", { class: "tilecount" }, [
  el("b", {}, ["–"]),
  el("span", {}, ["tiles left"]),
]);

function buildHud() {
  clear(hud);
  const topright = el("div", { class: "topright" });
  topright.append(muteBtn, menuBtn);
  const dock = el("div", { class: "dock" });
  dock.append(handCanvas, tileCountEl, promptEl);
  hud.append(scoresEl, topright, dock, confirmBtn, rotateBtn);
}

function updateTileCount() {
  if (!g) return;
  (tileCountEl.querySelector("b") as HTMLElement).textContent = String(g.deck.length);
}

// ---- final guided-scoring overlay -----------------------------------------
const scoreboardEl = el("div", { class: "scoreboard hidden" });
const scoreStatusEl = el("div", { class: "scorestatus hidden" });
const scoreBtnsEl = el("div", { class: "scorebtns hidden" });
overlay.append(scoreboardEl, scoreStatusEl, scoreBtnsEl);

/** Keep the on-tile rotate button centred on the pending tile, sized to it. */
function positionRotateBtn() {
  const show =
    !!g &&
    appMode === "game" &&
    g.phase === "placeTile" &&
    currentPlayer().kind === "human" &&
    !busy &&
    !!pendingCell;
  if (!show) {
    rotateBtn.classList.add("hidden");
    return;
  }
  rotateBtn.classList.remove("hidden");
  const ts = tileSize();
  const [px, py] = cellTopLeft(pendingCell!.x, pendingCell!.y);
  // cover the whole tile so tapping anywhere on it rotates; tap a neighbour to move
  rotateBtn.style.left = `${px + ts / 2}px`;
  rotateBtn.style.top = `${py + ts / 2}px`;
  rotateBtn.style.width = `${ts}px`;
  rotateBtn.style.height = `${ts}px`;
  rotateBtn.style.fontSize = `${ts * 0.34}px`;
}

// ---- tentative placement helpers ------------------------------------------
/** Empty cells adjacent to at least one placed tile (where a tile may go). */
function candidateKeys(): Set<string> {
  const keys = new Set<string>();
  if (!g) return keys;
  const deltas = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (const t of g.board.values()) {
    for (const [dx, dy] of deltas) {
      const nx = t.x + dx,
        ny = t.y + dy;
      const k = posKey(nx, ny);
      if (!g.board.has(k)) keys.add(k);
    }
  }
  return keys;
}
/** Is the pending cell + current rotation a legal placement? */
function pendingValid(): boolean {
  if (!g || !pendingCell) return false;
  return legal.some(
    (l) => l.x === pendingCell!.x && l.y === pendingCell!.y && l.rotation === g!.drawnRotation
  );
}
/** The bottom-right action button changes with context:
 *  - place-tile: green ✓ (disabled until a valid spot).
 *  - place-meeple + a spot chosen: green ✓ to confirm the meeple.
 *  - place-meeple + nothing chosen: a follower-with-a-slash "no meeple" button. */
function updateConfirm() {
  const human = !!g && currentPlayer().kind === "human" && !busy;
  const inTile = human && g!.phase === "placeTile";
  const inMeeple = human && g!.phase === "placeMeeple";
  if (!inTile && !inMeeple) {
    confirmBtn.className = "confirmbtn hidden";
    return;
  }
  if (inMeeple && pendingMeeple === null) {
    // "place no meeple": the player's actual meeple piece with a slash (CSS ::after)
    confirmBtn.className = "confirmbtn skipmode";
    confirmBtn.textContent = "";
    confirmBtn.style.background =
      `url(${meepleIcon(currentPlayer().color)}) center 44%/56% no-repeat,` +
      ` linear-gradient(180deg,#c9a48f,#9c6a52)`;
    return;
  }
  confirmBtn.textContent = "✓";
  confirmBtn.style.background = ""; // revert to the green .confirmbtn CSS
  const ok = (inTile && pendingValid()) || (inMeeple && pendingMeeple !== null);
  confirmBtn.className = "confirmbtn" + (ok ? "" : " off");
}

/** Render the meeple piece to a data-URL (per colour) for use as a button icon. */
const meepleIconCache = new Map<string, string>();
function meepleIcon(color: string): string {
  const cached = meepleIconCache.get(color);
  if (cached) return cached;
  const s = 56;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const cx = c.getContext("2d")!;
  drawMeeple(cx, s / 2, s / 2, s * 0.86, color, false);
  const url = c.toDataURL();
  // only cache once the 3D sprite is in — before that we'd bake the fallback
  if (meepleModelReady()) meepleIconCache.set(color, url);
  return url;
}
/** The bottom-right button commits whatever the human is arranging. */
function onConfirm() {
  if (!g || busy) return;
  if (g.phase === "placeTile") confirmPlacement();
  else if (g.phase === "placeMeeple") {
    if (pendingMeeple === null) humanSkipMeeple();
    else confirmMeeple();
  }
}
function confirmMeeple() {
  if (!g || busy || g.phase !== "placeMeeple") return;
  if (pendingMeeple === null) {
    audio.play("invalid");
    return;
  }
  const seg = pendingMeeple;
  pendingMeeple = null;
  confirmBtn.classList.add("hidden");
  const events = engine.placeMeeple(g, seg) || [];
  audio.play("meeple");
  finishTurn(events);
}
function confirmPlacement() {
  if (!g || busy || g.phase !== "placeTile") return;
  if (!pendingCell || !pendingValid()) {
    // can't confirm an empty / illegal spot — negative feedback
    audio.play("invalid");
    if (pendingCell) toast("Won't fit here — rotate ⟳", "#c0492f");
    return;
  }
  // The tile already flew into place when it was dropped — just commit it.
  const { x, y } = pendingCell;
  if (engine.placeTile(g, x, y, g.drawnRotation)) {
    audio.play("button");
    lastMove = { x, y, playerId: g.current };
    pendingCell = null;
    confirmBtn.classList.add("hidden");
    enterMeeplePhase();
  }
}

/** Fly the drawn tile from `from` (screen top-left + size) into board cell
 *  (gx,gy) as a tentative placement — used on the initial drop AND each move. */
function beginTileFly(gx: number, gy: number, from: { x: number; y: number; size: number }) {
  if (!g || !g.drawn) return;
  tileAnim = {
    def: g.drawn,
    rot: g.drawnRotation,
    x: gx,
    y: gy,
    from: { x: from.x, y: from.y },
    fromSize: from.size,
    born: performance.now(),
    dur: 220,
  };
  busy = true; // brief input block while it flies
  confirmBtn.classList.add("hidden");
  rotateBtn.classList.add("hidden");
  audio.play("draw"); // whoosh as it lifts
}

/** Called when a drop/move fly-in lands: the tile now sits as the tentative
 *  ghost at pendingCell (still not committed — the ✓ confirms it). */
function landTileAnim() {
  if (!g) return;
  tileAnim = null;
  busy = false;
  audio.play("place"); // the tile hits the table
  if (pendingCell && !pendingValid() && legal.some((l) => l.x === pendingCell!.x && l.y === pendingCell!.y))
    toast("Rotate to fit ⟳", "#c0492f");
  updateHandDock();
}
function toggleMute() {
  const m = !audio.isMuted();
  audio.setMuted(m);
  muteBtn.textContent = m ? "🔇" : "🔊";
}
function confirmQuit() {
  if (confirm("Quit this game and return to the menu?")) {
    audio.play("button");
    gotoMenu();
  }
}

function renderScores() {
  if (!g) return;
  clear(scoresEl);
  g.players.forEach((p, i) => {
    const chip = el("div", { class: "scorechip" + (i === g!.current ? " active" : "") });
    chip.append(
      el("span", { class: "dot", style: `background:${p.color}` }),
      el("span", {}, [`${p.name}`]),
      el("span", { class: "mp" }, [
        `${p.score} pts · `,
        el("img", { class: "mpicon", src: meepleIcon(p.color) }),
        ` ${p.meeplesLeft}`,
      ])
    );
    scoresEl.append(chip);
  });
}

function renderHand() {
  if (!g || !g.drawn) return;
  const hc = handCanvas.getContext("2d")!;
  hc.clearRect(0, 0, handCanvas.width, handCanvas.height);
  drawTile(hc, g.drawn, g.drawnRotation, 8, 8, handCanvas.width - 16);
}

function setPrompt(text: string) {
  promptEl.textContent = text;
}

// ---- match lifecycle -------------------------------------------------------
function startMatch(m: MatchConfig) {
  config = m;
  audio.init();
  audio.startMusic();
  const players: Player[] = m.players.map((pc, i) => ({
    id: i,
    name: pc.name,
    color: pc.color,
    kind: pc.kind,
    score: 0,
    meeplesLeft: 7,
  }));
  const seed = (Date.now() & 0xffffffff) >>> 0;
  g = engine.newGame(players, m.passAndPlay, seed, m.river);
  appMode = "game";
  lastMove = null;
  pendingCell = null;
  pendingMeeple = null;
  panTarget = null;
  highlightTiles = null;
  scorePopup = null;
  tileAnim = null;
  allScoreEvents = [];
  clear(overlay);
  overlay.append(hud, scoreboardEl, scoreStatusEl, scoreBtnsEl);
  scoreboardEl.classList.add("hidden");
  scoreStatusEl.classList.add("hidden");
  scoreBtnsEl.classList.add("hidden");
  hud.classList.remove("hidden");
  buildHud();
  updateTileCount();
  // center on start tile
  const start = [...g.board.values()][0];
  resize(); // ensure W/H reflect the current viewport before centering
  centerOn(start ? start.x : 0, start ? start.y : 0);
  handleTurnStart();
}

function currentPlayer(): Player {
  return g!.players[g!.current];
}

// Engine's newGame/endTurn already draw the next tile & set g.phase.
// The controller only reads g.drawn — it must NOT draw here.
function handleTurnStart() {
  if (!g) return;
  legalMeepleSpots = [];
  if (g.phase === "gameOver" || !g.drawn) {
    endMatch();
    return;
  }
  g.drawnRotation = 0;
  legal = engine.legalPlacements(g);
  if (legal.length === 0) {
    // no legal placement anywhere — advance without placing
    finishTurn([]);
    return;
  }
  renderScores();
  renderHand();
  updateTileCount();

  const p = currentPlayer();
  if (g.phase === "h&off" || (config!.passAndPlay && p.kind === "human")) {
    showHandoffScreen(p.name, p.color);
    return;
  }
  routeTurn();
}

function routeTurn() {
  if (!g) return;
  g.phase = "placeTile";
  const p = currentPlayer();
  if (p.kind === "ai") {
    runAiTurn();
  } else {
    busy = false;
    pendingCell = null;
    pendingMeeple = null;
    const onRiver = !!g.drawn?.edges.includes("river");
    setPrompt(onRiver ? "Place the river tile, then ✓" : "Drop your tile, rotate/move, then ✓");
    updateHandDock();
  }
}

function showHandoffScreen(name: string, color: string) {
  busy = true;
  confirmBtn.classList.add("hidden");
  const layer = el("div");
  overlay.append(layer);
  showHandoff(layer, name, color, () => {
    overlay.removeChild(layer);
    audio.play("handoff");
    routeTurn();
  });
}

function updateHandDock() {
  updateConfirm();
  renderHand();
}

function rotateDrawn() {
  if (!g || busy || g.phase !== "placeTile") return;
  g.drawnRotation = ((g.drawnRotation + 1) % 4) as Rotation;
  rotSpin += 90; // spin the faint glyph + ring so it reads as turning the tile
  rotIcon.style.transform = `rotate(${rotSpin}deg)`;
  rotRing.style.transform = `rotate(${rotSpin}deg)`;
  audio.play("rotate");
  renderHand();
  // if the tile is down but this rotation makes it unplayable, warn (negative
  // sound) and the ✓ becomes un-clickable.
  if (pendingCell && !pendingValid()) audio.play("invalid");
  updateConfirm();
}

// ---- human input on the board ---------------------------------------------
function humanTapCell(gx: number, gy: number) {
  if (!g || busy) return;
  const p = currentPlayer();
  if (p.kind !== "human") return;
  if (g.phase !== "placeTile") return;
  // Only drop onto a cell that touches the board (a real candidate square).
  if (!candidateKeys().has(posKey(gx, gy))) return;
  if (pendingCell && pendingCell.x === gx && pendingCell.y === gy) return; // already here
  // Fly the tile in from its previous spot — the hand preview on the first drop,
  // otherwise the cell it currently sits in. Nothing is committed until ✓.
  let from: { x: number; y: number; size: number };
  if (pendingCell) {
    const [px, py] = cellTopLeft(pendingCell.x, pendingCell.y);
    from = { x: px, y: py, size: tileSize() };
  } else {
    const hr = handCanvas.getBoundingClientRect();
    from = { x: hr.left, y: hr.top, size: hr.width };
  }
  pendingCell = { x: gx, y: gy };
  beginTileFly(gx, gy, from);
}

function enterMeeplePhase() {
  if (!g) return;
  const spots = engine.legalMeeples(g);
  const p = currentPlayer();
  if (p.meeplesLeft <= 0 || spots.length === 0) {
    // no meeple possible -> straight to finishing
    finishTurn(engine.placeMeeple(g, -1) || []);
    return;
  }
  g.phase = "placeMeeple";
  pendingMeeple = null;
  setPrompt("Tap a spot for a meeple, then ✓ — or the no-meeple button for none");
  rotateBtn.classList.add("hidden");
  updateConfirm(); // shows ✓ (once a spot is chosen) or the "no meeple" button
}

function humanTapMeeple(seg: number) {
  if (!g || busy || g.phase !== "placeMeeple") return;
  // select (don't commit) — the player confirms with ✓
  pendingMeeple = pendingMeeple === seg ? null : seg; // tap again to deselect
  audio.play("button");
  updateConfirm();
}
function humanSkipMeeple() {
  if (!g || busy || g.phase !== "placeMeeple") return;
  pendingMeeple = null;
  confirmBtn.classList.add("hidden");
  const events = engine.placeMeeple(g, -1) || [];
  audio.play("button");
  finishTurn(events);
}

/** In the meeple phase the tile isn't locked: tapping another square lifts the
 *  tile back up and drops it there, returning to the place/rotate/confirm flow. */
function moveTileBack(gx: number, gy: number) {
  if (!g || !lastMove) return;
  const t = g.board.get(posKey(lastMove.x, lastMove.y));
  if (!t) return;
  // fly from the tile's committed spot to the new square
  const [opx, opy] = cellTopLeft(lastMove.x, lastMove.y);
  const from = { x: opx, y: opy, size: tileSize() };
  g.board.delete(posKey(lastMove.x, lastMove.y));
  g.drawn = t.def;
  g.drawnRotation = t.rotation;
  g.phase = "placeTile";
  lastMove = null;
  pendingMeeple = null;
  legal = engine.legalPlacements(g);
  pendingCell = { x: gx, y: gy };
  setPrompt("Drop your tile, rotate/move, then ✓");
  beginTileFly(gx, gy, from);
}

// ---- AI --------------------------------------------------------------------
function runAiTurn() {
  if (!g) return;
  busy = true;
  setPrompt(`${currentPlayer().name} is thinking…`);
  rotateBtn.classList.add("hidden");
  confirmBtn.classList.add("hidden");
  setTimeout(() => {
    if (!g) return;
    const turn = chooseTurn(engine, g, config!.difficulty);
    // apply placement
    g.drawnRotation = turn.placement.rotation;
    renderHand();
    setTimeout(() => {
      if (!g) return;
      const placed = engine.placeTile(
        g,
        turn.placement.x,
        turn.placement.y,
        turn.placement.rotation
      );
      let mx = turn.placement.x, my = turn.placement.y;
      if (!placed) {
        // fallback: place first legal
        const l = legal[0];
        engine.placeTile(g, l.x, l.y, l.rotation);
        mx = l.x; my = l.y;
      }
      audio.play("place");
      lastMove = { x: mx, y: my, playerId: g.current };
      // pan toward AI move
      panTo(turn.placement.x, turn.placement.y);
      setTimeout(() => {
        if (!g) return;
        const events = engine.placeMeeple(g, turn.meepleSegmentIndex) || [];
        if (turn.meepleSegmentIndex >= 0) audio.play("meeple");
        finishTurn(events);
      }, 420);
    }, 380);
  }, 360);
}

// ---- end of turn / scoring -------------------------------------------------
function finishTurn(meepleEvents: ScoreEvent[]) {
  if (!g) return;
  const endEvents = engine.endTurn(g) || [];
  const all = [...meepleEvents, ...endEvents];
  for (const ev of all) if (ev.points > 0) allScoreEvents.push(ev);
  animateScores(all);
  renderScores();
  if (g.phase === "gameOver") {
    endMatch();
    return;
  }
  // small pause so the player registers scoring before next turn
  busy = true;
  setTimeout(() => {
    busy = false;
    handleTurnStart();
  }, all.length ? 700 : 120);
}

function animateScores(events: ScoreEvent[]) {
  if (!g) return;
  let anyPoints = false;
  for (const ev of events) {
    if (ev.points <= 0) continue;
    anyPoints = true;
    for (const pid of ev.playerIds) {
      const pl = g.players[pid];
      toast(`+${ev.points} ${featureLabel(ev.kind)} · ${pl?.name ?? ""}`, pl?.color);
    }
  }
  if (anyPoints) audio.play("score");
}
function featureLabel(kind: string): string {
  return kind === "city" ? "City" : kind === "road" ? "Road" : kind === "cloister" ? "Cloister" : "Field";
}

function endMatch() {
  beginFinalScoring();
}

// ---- guided final scoring --------------------------------------------------
function beginFinalScoring() {
  if (!g) return;
  appMode = "scoring";
  busy = true;
  audio.stopMusic();
  lastMove = null;
  pendingCell = null;
  pendingMeeple = null;
  hud.classList.add("hidden");
  // baseline displayed scores (before final points are applied)
  displayScores = g.players.map((p) => p.score);
  // finalScore applies the end-game points to g.players and returns the events
  scoringEvents = (engine.finalScore(g) || []).filter((e) => e.points > 0);
  for (const ev of scoringEvents) allScoreEvents.push(ev);
  scoringIndex = 0;
  buildScoreboard();
  scoreboardEl.classList.remove("hidden");
  scoreStatusEl.classList.remove("hidden");
  scoreStatusEl.textContent = scoringEvents.length ? "Final scoring…" : "Tallying the board…";
  clear(scoreBtnsEl);
  scoreBtnsEl.append(button("Skip ▶▶", () => fastForwardScoring(), "btn small"));
  scoreBtnsEl.classList.remove("hidden");
  setTimeout(stepScoring, 700);
}

function buildScoreboard() {
  if (!g) return;
  clear(scoreboardEl);
  scoreboardEl.append(el("h3", {}, ["Final Scoring"]));
  g.players.forEach((p, i) => {
    const row = el("div", { class: "scorerow", "data-pid": String(i) });
    row.append(
      el("span", { class: "dot", style: `background:${p.color}` }),
      el("span", { class: "nm" }, [p.name]),
      el("span", { class: "sc" }, [String(displayScores[i])])
    );
    scoreboardEl.append(row);
  });
}

function updateScoreboard(bumpPids: number[] = []) {
  for (const row of scoreboardEl.querySelectorAll(".scorerow")) {
    const pid = Number(row.getAttribute("data-pid"));
    const sc = row.querySelector(".sc") as HTMLElement;
    sc.textContent = String(displayScores[pid]);
    if (bumpPids.includes(pid)) {
      sc.classList.remove("bump");
      void sc.offsetWidth; // reflow to restart the pop animation
      sc.classList.add("bump");
    }
  }
}

/** Score round-up status line: a pixel feature icon followed by the text. */
function setScoreStatus(kind: string, text: string) {
  clear(scoreStatusEl);
  scoreStatusEl.append(
    el("img", { class: "sicon", src: featureIconDataUrl(kind) }),
    document.createTextNode(text)
  );
}

function stepScoring() {
  if (!g || appMode !== "scoring") return;
  if (scoringIndex >= scoringEvents.length) {
    finishScoring();
    return;
  }
  const ev = scoringEvents[scoringIndex];
  highlightTiles = ev.tiles;
  highlightColor = g.players[ev.playerIds[0]]?.color ?? "#ffd76b"; // scorer's colour
  const cx = ev.tiles.reduce((s, t) => s + t.x, 0) / ev.tiles.length;
  const cy = ev.tiles.reduce((s, t) => s + t.y, 0) / ev.tiles.length;
  panTo(cx, cy);
  const names = ev.playerIds.map((pid) => g!.players[pid]?.name).join(" & ");
  setScoreStatus(ev.kind, `${featureLabel(ev.kind)} — +${ev.points} to ${names}`);
  // big glowing score number pops up over the feature in the scorer's colour
  scorePopup = { x: cx, y: cy, points: ev.points, color: highlightColor, kind: ev.kind, born: performance.now() };
  setTimeout(() => {
    if (!g || appMode !== "scoring") return;
    for (const pid of ev.playerIds) displayScores[pid] += ev.points;
    updateScoreboard(ev.playerIds);
    audio.play("score");
    scoringIndex++;
    setTimeout(stepScoring, 1150);
  }, 700);
}

function fastForwardScoring() {
  if (!g) return;
  for (let i = scoringIndex; i < scoringEvents.length; i++)
    for (const pid of scoringEvents[i].playerIds) displayScores[pid] += scoringEvents[i].points;
  scoringIndex = scoringEvents.length;
  updateScoreboard();
  finishScoring();
}

function finishScoring() {
  if (!g) return;
  highlightTiles = null;
  scorePopup = null;
  scoreStatusEl.classList.add("hidden");
  audio.play("victory");
  const best = Math.max(...displayScores);
  for (const row of scoreboardEl.querySelectorAll(".scorerow")) {
    const pid = Number(row.getAttribute("data-pid"));
    row.classList.toggle("lead", displayScores[pid] === best);
  }
  const winners = g.players.filter((_, i) => displayScores[i] === best).map((p) => p.name);
  (scoreboardEl.querySelector("h3") as HTMLElement).textContent =
    winners.length === 1 ? `${winners[0]} wins!` : `Tie — ${winners.join(" & ")}`;
  appMode = "gameover";
  busy = false;
  clear(scoreBtnsEl);
  scoreBtnsEl.append(
    button("Rematch ↻", () => startMatch(config!), "btn gold small"),
    button("Main Menu", () => gotoMenu(), "btn small")
  );
}

// ---- pointer input (pan / zoom / tap) --------------------------------------
interface Ptr { x: number; y: number; sx: number; sy: number; moved: boolean; }
const ptrs = new Map<number, Ptr>();
let pinchDist = 0;

canvas.addEventListener("pointerdown", (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic / lost pointer */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false });
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener("pointermove", (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) p.moved = true;
  p.x = e.clientX;
  p.y = e.clientY;
  if (ptrs.size === 1) {
    cam.x += dx;
    cam.y += dy;
    panTarget = null; // manual drag cancels any auto-pan
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const nd = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      zoomAt(mx, my, nd / pinchDist);
    }
    pinchDist = nd;
  }
});
function endPtr(e: PointerEvent) {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const wasTap = !p.moved && ptrs.size === 1;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinchDist = 0;
  if (wasTap) handleTap(e.clientX, e.clientY);
}
canvas.addEventListener("pointerup", endPtr);
canvas.addEventListener("pointercancel", (e) => ptrs.delete(e.pointerId));
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

function zoomAt(cx: number, cy: number, factor: number) {
  const old = cam.scale;
  cam.scale = Math.max(0.3, Math.min(1.6, cam.scale * factor));
  const k = cam.scale / old;
  cam.x = cx - (cx - cam.x) * k;
  cam.y = cy - (cy - cam.y) * k;
}

function handleTap(sx: number, sy: number) {
  if (appMode !== "game" || !g || busy) return;
  if (g.phase === "placeMeeple") {
    // hit-test meeple spots first
    let best = -1,
      bestD = 38 * 38;
    for (const s of legalMeepleSpots) {
      const d = (s.x - sx) ** 2 + (s.y - sy) ** 2;
      if (d < bestD) { bestD = d; best = s.seg; }
    }
    if (best >= 0) { humanTapMeeple(best); return; }
    // otherwise a tap on an open square lifts the tile and re-places it there
    const [gx, gy] = screenToCell(sx, sy);
    if (candidateKeys().has(posKey(gx, gy))) moveTileBack(gx, gy);
    return;
  }
  if (g.phase === "placeTile") {
    const [gx, gy] = screenToCell(sx, sy);
    humanTapCell(gx, gy);
  }
}

// ---- render loop -----------------------------------------------------------
function drawGrass() {
  const ts = tileSize();
  // base
  ctx.fillStyle = "#4b7f3a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // subtle checker to read the grid
  ctx.save();
  ctx.globalAlpha = 0.06;
  const startX = Math.floor(-cam.x / ts) - 1;
  const startY = Math.floor(-cam.y / ts) - 1;
  const cols = Math.ceil(W / ts) + 2;
  const rows = Math.ceil(H / ts) + 2;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const gx = startX + ix, gy = startY + iy;
      if (((gx + gy) & 1) === 0) continue;
      const [px, py] = cellTopLeft(gx, gy);
      ctx.fillStyle = "#000";
      ctx.fillRect(px * DPR, py * DPR, ts * DPR, ts * DPR);
    }
  }
  ctx.restore();
}

function frame() {
  requestAnimationFrame(frame);
  // smooth auto-pan
  if (panTarget) {
    cam.x += (panTarget.x - cam.x) * 0.14;
    cam.y += (panTarget.y - cam.y) * 0.14;
    if (Math.hypot(panTarget.x - cam.x, panTarget.y - cam.y) < 0.5) panTarget = null;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGrass();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  if (g) {
    const ts = tileSize();
    // placement hints (tentative-placement mode)
    if (appMode === "game" && g.phase === "placeTile" && currentPlayer().kind === "human" && !busy) {
      const rot = g.drawnRotation;
      const pulse = (performance.now() / 500) % 1;
      ctx.save();
      // every candidate square gets a faint marker so you know where you can try
      const cands = candidateKeys();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      for (const key of cands) {
        const [sx, sy] = key.split(",").map(Number);
        const [px, py] = cellTopLeft(sx, sy);
        ctx.strokeStyle = "rgba(244,228,188,0.28)";
        ctx.strokeRect(px + 5, py + 5, ts - 10, ts - 10);
      }
      // cells where the CURRENT rotation would fit glow gold
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      for (const l of legal) {
        if (l.rotation !== rot) continue;
        const [px, py] = cellTopLeft(l.x, l.y);
        ctx.strokeStyle = `rgba(242,193,78,${0.5 + 0.35 * Math.sin(pulse * Math.PI * 2)})`;
        ctx.strokeRect(px + 3, py + 3, ts - 6, ts - 6);
      }
      ctx.restore();
    }

    // during meeple placement the tile isn't locked — show open squares faintly
    // so the player knows they can still move it.
    if (appMode === "game" && g.phase === "placeMeeple" && currentPlayer().kind === "human" && !busy) {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(244,228,188,0.2)";
      for (const key of candidateKeys()) {
        const [sx, sy] = key.split(",").map(Number);
        const [px, py] = cellTopLeft(sx, sy);
        ctx.strokeRect(px + 5, py + 5, ts - 10, ts - 10);
      }
      ctx.restore();
    }

    // tiles
    for (const pt of g.board.values()) {
      const [px, py] = cellTopLeft(pt.x, pt.y);
      if (px < -ts || py < -ts || px > W || py > H) continue;
      drawTile(ctx, pt.def, pt.rotation, px, py, ts);
      if (pt.meeple) {
        const seg = pt.def.segments[pt.meeple.segmentIndex];
        if (seg) {
          const sp = computeMeepleSpot(pt.def, pt.rotation, pt.meeple.segmentIndex);
          const cx = px + sp.x * ts;
          const cy = py + sp.y * ts;
          const col = g.players[pt.meeple.playerId]?.color ?? "#fff";
          // farmers lie on their back; everyone else stands
          drawMeeple(ctx, cx, cy, ts * 0.42, col, seg.kind === "field");
        }
      }
    }

    // previous move — subtle outline in the placer's colour
    if (lastMove && (appMode === "game" || appMode === "scoring")) {
      const [px, py] = cellTopLeft(lastMove.x, lastMove.y);
      if (px > -ts && py > -ts && px < W && py < H) {
        const col = g.players[lastMove.playerId]?.color ?? "#fff";
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.32;
        ctx.lineWidth = 6;
        ctx.strokeStyle = col;
        ctx.strokeRect(px + 3, py + 3, ts - 6, ts - 6);
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(px + 3, py + 3, ts - 6, ts - 6);
        ctx.restore();
      }
    }

    // guided final scoring — highlight the feature currently being tallied, in
    // the SCORING PLAYER'S colour so it's clear whose points these are.
    if (highlightTiles && appMode === "scoring") {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      const rgb = rgbTriplet(highlightColor);
      ctx.save();
      ctx.setLineDash([]);
      ctx.shadowColor = `rgba(${rgb},${0.5 + 0.4 * pulse})`;
      ctx.shadowBlur = ts * (0.16 + 0.1 * pulse);
      for (const t of highlightTiles) {
        const [px, py] = cellTopLeft(t.x, t.y);
        ctx.fillStyle = `rgba(${rgb},${0.22 + 0.16 * pulse})`;
        ctx.fillRect(px, py, ts, ts);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = `rgba(${rgb},${0.7 + 0.3 * pulse})`;
        ctx.strokeRect(px + 1.75, py + 1.75, ts - 3.5, ts - 3.5);
      }
      ctx.restore();
    }

    // big glowing "+N" over the feature being tallied, in the scorer's colour.
    if (scorePopup && appMode === "scoring") {
      const age = performance.now() - scorePopup.born;
      const e = 1 - Math.pow(1 - Math.min(1, age / 260), 3); // ease-out pop-in
      const bob = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      const scale = 0.45 + 0.55 * e;
      const [tx, ty] = cellTopLeft(scorePopup.x, scorePopup.y);
      const cx = tx + ts / 2;
      const cy = ty + ts / 2 - 6 * e; // settle slightly above centre
      const rgb = rgbTriplet(scorePopup.color);
      const fontPx = Math.round(ts * 0.9 * scale);
      const txt = `+${scorePopup.points}`;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${fontPx}px "Trebuchet MS", sans-serif`;
      // soft coloured halo disc behind the number
      ctx.fillStyle = `rgba(${rgb},${0.16 + 0.1 * bob})`;
      ctx.beginPath();
      ctx.arc(cx, cy, fontPx * 0.72, 0, Math.PI * 2);
      ctx.fill();
      // coloured glow + dark outline + white fill for punchy legibility
      ctx.shadowColor = `rgba(${rgb},0.95)`;
      ctx.shadowBlur = ts * (0.4 + 0.12 * bob);
      ctx.lineWidth = Math.max(3, fontPx * 0.14);
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(txt, cx, cy);
      ctx.shadowBlur = ts * 0.3;
      ctx.fillStyle = "#fff";
      ctx.fillText(txt, cx, cy);
      // crisp pixel feature icon sitting just above the number
      ctx.shadowBlur = 0;
      ctx.imageSmoothingEnabled = false;
      const icon = featureIconCanvas(scorePopup.kind);
      const isz = Math.round(fontPx * 0.72);
      ctx.drawImage(icon, Math.round(cx - isz / 2), Math.round(cy - fontPx * 0.55 - isz), isz, isz);
      ctx.restore();
    }

    // tentative (pending) tile the human is positioning
    if (
      appMode === "game" &&
      g.phase === "placeTile" &&
      currentPlayer().kind === "human" &&
      !busy &&
      pendingCell &&
      g.drawn
    ) {
      const [px, py] = cellTopLeft(pendingCell.x, pendingCell.y);
      drawTile(ctx, g.drawn, g.drawnRotation, px, py, ts, { ghost: true });
      const ok = pendingValid();
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = ok ? "#4caf50" : "#c0492f";
      ctx.strokeRect(px + 2, py + 2, ts - 4, ts - 4);
      ctx.restore();
    }

    // meeple placement markers
    legalMeepleSpots = [];
    if (appMode === "game" && g.phase === "placeMeeple" && currentPlayer().kind === "human" && !busy) {
      const spots = engine.legalMeeples(g);
      const placed = lastPlacedTile();
      if (placed) {
        const [ptx, pty] = cellTopLeft(placed.x, placed.y);
        const t = (performance.now() / 400) % 1;
        const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
        const col = currentPlayer().color;
        const R = ts * 0.22;
        const msize = ts * 0.34;
        // A transparent GHOST meeple sits exactly where the follower would go —
        // on the deepest-interior point of its feature (city stone / grass / road)
        // — so it's clear what each option claims. Farmers lie on their side.
        for (const ms of spots) {
          const seg = placed.def.segments[ms.segmentIndex];
          if (!seg) continue;
          const sp = computeMeepleSpot(placed.def, placed.rotation, ms.segmentIndex);
          const cx = ptx + sp.x * ts;
          const cy = pty + sp.y * ts;
          legalMeepleSpots.push({ seg: ms.segmentIndex, x: cx, y: cy });
          const selected = pendingMeeple === ms.segmentIndex;
          ctx.save();
          // halo — brighter (green) on the selected spot
          ctx.beginPath();
          ctx.arc(cx, cy, R, 0, Math.PI * 2);
          ctx.fillStyle = selected
            ? "rgba(120,220,120,0.32)"
            : `rgba(255,248,220,${0.16 + 0.12 * pulse})`;
          ctx.fill();
          ctx.lineWidth = selected ? 3 : 2;
          ctx.strokeStyle = selected
            ? "#4caf50"
            : `rgba(255,246,214,${0.45 + 0.4 * pulse})`;
          ctx.stroke();
          // the selected meeple is solid; the other options are faint ghosts
          ctx.globalAlpha = selected ? 1 : 0.55;
          drawMeeple(ctx, cx, cy, msize, col, ms.kind === "field");
          ctx.restore();
        }
      }
    }

    // end-board indicators: a coloured badge on each scored feature showing who
    // got the points (split disc for a tie).
    if (appMode === "gameover" && allScoreEvents.length) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const ev of allScoreEvents) {
        const gxc = ev.tiles.reduce((s, t) => s + t.x, 0) / ev.tiles.length;
        const gyc = ev.tiles.reduce((s, t) => s + t.y, 0) / ev.tiles.length;
        const [px, py] = cellTopLeft(gxc, gyc);
        const bx = px + ts * 0.5, by = py + ts * 0.5, rad = ts * 0.17;
        const cols = ev.playerIds.map((pid) => g!.players[pid]?.color ?? "#fff");
        ctx.beginPath();
        ctx.arc(bx, by, rad + 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20,14,8,0.55)";
        ctx.fill();
        if (cols.length <= 1) {
          ctx.beginPath();
          ctx.arc(bx, by, rad, 0, Math.PI * 2);
          ctx.fillStyle = cols[0] ?? "#fff";
          ctx.fill();
        } else {
          cols.forEach((c, i) => {
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.arc(bx, by, rad, (i / cols.length) * 6.283 - 1.571, ((i + 1) / cols.length) * 6.283 - 1.571);
            ctx.closePath();
            ctx.fillStyle = c;
            ctx.fill();
          });
        }
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(bx, by, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = `900 ${Math.round(rad * 1.05)}px "Trebuchet MS", sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.strokeText(String(ev.points), bx, by);
        ctx.fillStyle = "#fff";
        ctx.fillText(String(ev.points), bx, by);
      }
      ctx.restore();
    }

    // flying tile — animates from the hand preview to its board cell, then lands
    if (tileAnim) {
      const p = Math.min(1, (performance.now() - tileAnim.born) / tileAnim.dur);
      const e = 1 - Math.pow(1 - p, 3);
      const [tx, ty] = cellTopLeft(tileAnim.x, tileAnim.y);
      const size = tileAnim.fromSize + (ts - tileAnim.fromSize) * e;
      const fcx = tileAnim.from.x + tileAnim.fromSize / 2;
      const fcy = tileAnim.from.y + tileAnim.fromSize / 2;
      const cx = fcx + (tx + ts / 2 - fcx) * e;
      const cy = fcy + (ty + ts / 2 - fcy) * e - Math.sin(p * Math.PI) * 20;
      drawTile(ctx, tileAnim.def, tileAnim.rot, cx - size / 2, cy - size / 2, size);
      if (p >= 1) landTileAnim();
    }
  }

  positionRotateBtn();

  // toasts
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const now = performance.now();
  ctx.textAlign = "center";
  for (let i = toasts.length - 1; i >= 0; i--) {
    const tt = toasts[i];
    const age = (now - tt.born) / 1600;
    if (age >= 1) { toasts.splice(i, 1); continue; }
    const y = (H * 0.22 - age * 40) * DPR;
    ctx.globalAlpha = age < 0.15 ? age / 0.15 : 1 - Math.max(0, (age - 0.8) / 0.2);
    ctx.font = `900 ${18 * DPR}px "Trebuchet MS", sans-serif`;
    ctx.lineWidth = 4 * DPR;
    ctx.strokeStyle = "rgba(61,43,31,0.9)";
    ctx.strokeText(tt.text, (W / 2) * DPR, y + (toasts.length - 1 - i) * 26 * DPR);
    ctx.fillStyle = tt.color;
    ctx.fillText(tt.text, (W / 2) * DPR, y + (toasts.length - 1 - i) * 26 * DPR);
    ctx.globalAlpha = 1;
  }
}

function lastPlacedTile() {
  // the just-placed tile is tracked via a module var
  return _lastPlaced;
}
let _lastPlaced: import("./core/types").PlacedTile | null = null;

// wrap engine.placeTile to remember the last placed tile for meeple UI
const _origPlace = engine.placeTile.bind(engine);
engine.placeTile = (state, x, y, rot) => {
  const r = _origPlace(state, x, y, rot);
  if (r) _lastPlaced = state.board.get(posKey(x, y)) ?? null;
  return r;
};

// rotate a tile-local 0..1 spot by rotation (90° CW steps), y-down coords
function rotateSpot(x: number, y: number, rot: number): [number, number] {
  let dx = x - 0.5, dy = y - 0.5;
  for (let i = 0; i < (rot & 3); i++) {
    const ndx = -dy, ndy = dx;
    dx = ndx; dy = ndy;
  }
  return [0.5 + dx, 0.5 + dy];
}

// ---- boot ------------------------------------------------------------------
// unlock audio on first gesture
const unlock = () => { audio.init(); };
window.addEventListener("pointerdown", unlock, { once: true });

loadMeeple3D(); // fetch + prepare the 3D meeple model (sprites cache lazily)
gotoMenu();
requestAnimationFrame(frame);

// dev-only test hook
if ((import.meta as any).env?.DEV) {
  (window as any).__t3d = {
    get g() { return g; },
    cam,
    legalNow: () => legal,
    tapCell: (gx: number, gy: number) => humanTapCell(gx, gy),
    tapMeeple: (seg: number) => humanTapMeeple(seg),
    skipMeeple: () => humanSkipMeeple(),
    rotate: () => rotateDrawn(),
    gotoMenu: () => gotoMenu(),
    audio,
  };
}
