// ============================================================================
// How-to-Play guide — a scrollable overlay that teaches T3dassonne from scratch.
// Two tabs: a fast "Quick Start" and a comprehensive "Full Rules", both using
// the REAL tile art (rendered via the pixel tile renderer) so a brand-new player
// can recognise everything on the board. Opened from the menus and the in-game
// help button; self-contained DOM (works over the farm UI and the classic UI).
// ============================================================================

import { el, clear } from "./dom";
import { drawTile, computeMeepleSpot, drawMeeple } from "../render";
import { TILE_DEFS } from "../core/tiles";
import type { Rotation } from "../core/types";

const KNIGHT = "#3a72d4"; // blue
const THIEF = "#d4453a";  // red
const FARMER = "#57b04a"; // green
const MONK = "#9b59b6";   // purple

interface TileOpts { rot?: Rotation; size?: number; meeples?: { seg: number; color: string }[]; caption?: string; }

/** A small crisp canvas showing a real tile (optionally with meeples on it). */
function tile(id: string, opts: TileOpts = {}): HTMLElement {
  const def = TILE_DEFS[id];
  const size = opts.size ?? 76;
  const rot = (opts.rot ?? 0) as Rotation;
  const wrap = el("figure", { class: "g-tile" });
  const cv = document.createElement("canvas");
  const px = size * 2;
  cv.width = px; cv.height = px;
  cv.style.width = size + "px"; cv.style.height = size + "px";
  const ctx = cv.getContext("2d")!;
  if (def) {
    drawTile(ctx, def, rot, 0, 0, px);
    for (const m of opts.meeples ?? []) {
      const sp = computeMeepleSpot(def, rot, m.seg);
      drawMeeple(ctx, sp.x * px, sp.y * px, px * 0.4, m.color, false);
    }
  }
  wrap.append(cv);
  if (opts.caption) wrap.append(el("figcaption", {}, [opts.caption]));
  return wrap;
}

/** A little colour swatch + label used to name a follower role. */
function role(color: string, label: string): HTMLElement {
  const w = el("span", { class: "g-role" });
  w.append(el("span", { class: "g-dot", style: `background:${color}` }), document.createTextNode(label));
  return w;
}

const h = (t: string) => el("h3", { class: "g-h" }, [t]);
const h2 = (t: string) => el("h2", { class: "g-h2" }, [t]);
const p = (html: string) => { const d = el("p", { class: "g-p" }); d.innerHTML = html; return d; };
const row = (...kids: (HTMLElement | Node)[]) => el("div", { class: "g-row" }, kids);
const note = (html: string) => { const d = el("div", { class: "g-note" }); d.innerHTML = html; return d; };

function ul(items: string[]): HTMLElement {
  const list = el("ul", { class: "g-ul" });
  for (const it of items) { const li = el("li"); li.innerHTML = it; list.append(li); }
  return list;
}

function table(headers: string[], rows: string[][]): HTMLElement {
  const wrap = el("div", { class: "g-tablewrap" });
  const tbl = el("table", { class: "g-table" });
  const thead = el("thead"); const htr = el("tr");
  for (const hd of headers) htr.append(el("th", {}, [hd]));
  thead.append(htr); tbl.append(thead);
  const tb = el("tbody");
  for (const r of rows) { const tr = el("tr"); for (const c of r) { const td = el("td"); td.innerHTML = c; tr.append(td); } tb.append(tr); }
  tbl.append(tb); wrap.append(tbl);
  return wrap;
}

// ---- Quick Start -----------------------------------------------------------
function buildQuickStart(): HTMLElement {
  const c = el("div", { class: "g-body" });
  c.append(
    h2("The idea"),
    p("Build a shared countryside by laying land tiles, and claim <b>roads, cities, monasteries and fields</b> with your followers to score points. Most points at the end wins."),
    row(tile("D", { caption: "The start tile" }), tile("E", { caption: "A city tile" }), tile("U", { caption: "A road tile" }), tile("B", { caption: "A monastery" })),

    h2("Your turn — 3 steps"),
    ul([
      "<b>1. Place your tile.</b> You draw one tile. Put it next to tiles already on the board so <b>every touching edge matches</b> — road to road, city to city, field to field. You can rotate it.",
      "<b>2. Place a follower (optional).</b> You may put one of your followers on a feature <b>on the tile you just placed</b> — but only if no follower already sits anywhere on that same road / city / field / monastery.",
      "<b>3. Score.</b> If your placement <b>finishes</b> a road, city or monastery, it scores right away and those followers come back to you.",
    ]),

    h2("Where a follower goes"),
    p("The same wooden follower does a different job depending on where you stand it:"),
    row(
      tile("U", { meeples: [{ seg: roadSeg("U"), color: THIEF }], caption: "Road = thief" }),
      tile("E", { meeples: [{ seg: citySeg("E"), color: KNIGHT }], caption: "City = knight" }),
      tile("B", { meeples: [{ seg: cloisterSeg("B"), color: MONK }], caption: "Monastery = monk" }),
      tile("E", { meeples: [{ seg: fieldSeg("E"), color: FARMER }], caption: "Field = farmer" }),
    ),

    h2("Quick scoring"),
    table(["Feature", "While playing", "How to finish"], [
      ["Road", "<b>1</b> point per tile", "both ends closed off (or a loop)"],
      ["City", "<b>2</b> per tile <b>+2</b> per shield", "fully walled with no gaps"],
      ["Monastery", "<b>9</b> when done", "all 8 surrounding tiles present"],
      ["Field", "scored only at the end", "—"],
    ]),
    note("Only <b>one</b> follower can start a feature. If two players' features later merge, whoever has <b>more</b> followers takes all the points (a tie pays <b>both</b> in full)."),

    h2("Ending the game"),
    p("The game ends when the last tile is placed. Anything unfinished still scores (a little less), and then <b>fields</b> pay out — see the Full Rules tab for the details. Highest total wins."),
    note("Want everything? Tap <b>Full Rules</b> above for a from-scratch explanation of every feature, shields, majorities, the farmers, and the River."),
  );
  return c;
}

// ---- Full Rules ------------------------------------------------------------
function buildFullRules(): HTMLElement {
  const c = el("div", { class: "g-body" });
  c.append(
    h2("Goal & setup"),
    p("T3dassonne is a tile-laying game for <b>2–5 players</b>. You take turns drawing and placing land tiles to grow one shared map, and you claim features with your <b>7 followers</b> to score. The player with the most points when the tiles run out wins."),
    p("The map starts from a single <b>start tile</b> (a city on one side, a road straight through):"),
    row(tile("D", { size: 96, caption: "Start tile" })),

    h2("1 · Placing a tile"),
    ul([
      "On your turn you draw <b>one</b> tile and must place it if you can.",
      "It has to touch at least one tile already on the board, and <b>every shared edge must match</b>: city meets city, road meets road, field meets field.",
      "You may rotate the tile to any of its four orientations to make it fit.",
      "If a drawn tile genuinely cannot be placed anywhere, it's discarded and you draw another.",
    ]),
    row(
      tile("U", { rot: 0, caption: "road runs N–S" }),
      tile("U", { rot: 1, caption: "same tile, rotated" }),
      tile("V", { caption: "a curve" }),
      tile("W", { caption: "a junction" }),
    ),

    h2("2 · Placing a follower"),
    p("After placing your tile you may deploy <b>one follower</b> from your supply. Three rules:"),
    ul([
      "It must go on a feature <b>of the tile you just placed</b>.",
      "That whole connected feature must be <b>empty</b> — you can't add to a road, city or field that already has anyone's follower on it.",
      "You have a limited pool (7). Followers on <b>completed</b> roads, cities and monasteries come back; <b>farmers never return</b>.",
    ]),
    p("The follower's role is just where it stands:"),
    row(
      tile("W", { meeples: [{ seg: roadSeg("W"), color: THIEF }], caption: "Thief (road)" }),
      tile("C", { meeples: [{ seg: citySeg("C"), color: KNIGHT }], caption: "Knight (city)" }),
      tile("B", { meeples: [{ seg: cloisterSeg("B"), color: MONK }], caption: "Monk (monastery)" }),
      tile("E", { meeples: [{ seg: fieldSeg("E"), color: FARMER }], caption: "Farmer (field)" }),
    ),

    h2("3 · Roads"),
    p("A <b>thief</b> scores a road when it is <b>closed at both ends</b> — an end is a city, a monastery, a crossroads, or a loop back on itself."),
    table(["When", "Score"], [["Completed (during play)", "<b>1 point per tile</b> in the road"], ["Unfinished (game end)", "<b>1 point per tile</b>"]]),

    h2("4 · Cities"),
    p("A <b>knight</b> scores a city when it is <b>completely walled</b> with no open gaps. Some city tiles carry a <b>shield</b> (a small pennant) — that tile is worth double."),
    row(
      tile("E", { caption: "one city edge" }),
      tile("F", { caption: "city + shield" }),
      tile("C", { caption: "big shielded city" }),
    ),
    table(["When", "Score"], [
      ["Completed (during play)", "<b>2 per tile + 2 per shield</b>"],
      ["Unfinished (game end)", "<b>1 per tile + 1 per shield</b>"],
    ]),
    note("The blue shield with a gold cross is <b>not</b> decoration — it means that city tile counts twice when the city scores."),

    h2("5 · Monasteries (cloisters)"),
    p("A <b>monk</b> scores when the monastery tile is <b>surrounded on all 8 sides</b> (including diagonals). Some monasteries also have a road leading out."),
    row(
      tile("B", { size: 92, meeples: [{ seg: cloisterSeg("B"), color: MONK }], caption: "monastery" }),
      tile("A", { size: 92, caption: "monastery + road" }),
    ),
    table(["When", "Score"], [
      ["Completed (all 8 neighbours)", "<b>9</b> (the tile + 8 around it)"],
      ["Unfinished (game end)", "<b>1 + the neighbours present</b>"],
    ]),

    h2("6 · Fields & farmers (the tricky one)"),
    p("Fields are the green land. A <b>farmer</b> lies down in a field and <b>stays there for the whole game</b> — it never comes back, and fields are <b>only scored at the very end</b>."),
    ul([
      "A field can spread across many tiles; roads and cities act as fences that divide fields.",
      "At the end, a field pays <b>3 points for every <u>completed</u> city that it touches</b>.",
      "Only completed cities count — a city that never got finished feeds no farmer.",
      "As with everything, if farmers from different players share a field, the one with the <b>most</b> farmers takes it (ties pay both).",
    ]),
    row(tile("E", { size: 96, meeples: [{ seg: fieldSeg("E"), color: FARMER }], caption: "a farmer beside a city" })),
    note("Farmers are a long game: a single farmer touching three finished cities is worth 9 points — but you're down a follower all game."),

    h2("7 · Majority — who actually scores"),
    p("You can never place onto a feature someone already holds, but separate pieces of a city or road (each started by a different player) can <b>merge</b> as the map grows. When a shared feature scores:"),
    ul([
      "The player with the <b>most</b> followers on it scores the <b>full</b> value.",
      "On a <b>tie</b>, every tied player scores the <b>full</b> value (it is not split).",
      "A tile with two separate city parts still counts as <b>one tile</b> — no double counting.",
    ]),

    h2("8 · Game end & final scoring"),
    p("The game ends the moment the last tile is placed. Then, in order:"),
    ul([
      "<b>Unfinished features</b> score at the reduced rate: roads <b>1/tile</b>, cities <b>1/tile +1/shield</b>, monasteries <b>1 + neighbours present</b>.",
      "<b>Fields</b> score: <b>3 points per completed city</b> each field touches, to the farmer majority.",
      "Highest total wins; a tie shares the win.",
    ]),

    h2("9 · The River (optional start)"),
    p("If <b>River</b> is switched on, the game begins by laying a winding river before any normal tiles. The water is just scenery — it scores nothing and holds no follower — but features sitting on river tiles (roads, small cities, a monastery) score exactly as normal."),
    row(tile("RSRC", { caption: "the spring (start)" }), tile("RLAK", { caption: "the lake (end)" }), tile("RSTR", { caption: "river + road" })),
    ul([
      "The <b>spring</b> replaces the start tile; the <b>lake</b> ends the river.",
      "Each river tile must extend the river, and you may not bend it straight back on itself (no U-turns).",
      "Once the river is complete, play continues with the normal land tiles as usual.",
    ]),

    h2("Followers at a glance"),
    row(
      role(THIEF, "Thief — roads"),
      role(KNIGHT, "Knight — cities"),
      role(MONK, "Monk — monasteries"),
      role(FARMER, "Farmer — fields"),
    ),
    p("They're all the same wooden piece — where you place it decides its job. You have seven; spend them wisely."),
  );
  return c;
}

// ---- segment lookups (so examples point at the right feature) --------------
function firstSeg(id: string, kind: string): number {
  const def = TILE_DEFS[id];
  const s = def?.segments.find((seg) => seg.kind === kind);
  return s ? s.index : 0;
}
const roadSeg = (id: string) => firstSeg(id, "road");
const citySeg = (id: string) => firstSeg(id, "city");
const cloisterSeg = (id: string) => firstSeg(id, "cloister");
const fieldSeg = (id: string) => firstSeg(id, "field");

// ---- overlay ---------------------------------------------------------------
let openEl: HTMLElement | null = null;

/** Open the guide overlay. `tab` picks the initial view. */
export function openGuide(tab: "quick" | "full" = "quick"): void {
  closeGuide();
  const overlay = el("div", { class: "guide-overlay" });
  const panel = el("div", { class: "guide-panel" });

  const bar = el("div", { class: "guide-bar" });
  const tabs = el("div", { class: "guide-tabs" });
  const quickBtn = el("button", { class: "guide-tab" }, ["Quick Start"]);
  const fullBtn = el("button", { class: "guide-tab" }, ["Full Rules"]);
  tabs.append(quickBtn, fullBtn);
  const closeBtn = el("button", { class: "guide-close" }, ["✕"]);
  bar.append(el("div", { class: "guide-title" }, ["How to Play"]), tabs, closeBtn);

  const scroll = el("div", { class: "guide-scroll" });

  const show = (which: "quick" | "full") => {
    clear(scroll);
    quickBtn.classList.toggle("on", which === "quick");
    fullBtn.classList.toggle("on", which === "full");
    scroll.append(which === "quick" ? buildQuickStart() : buildFullRules());
    scroll.scrollTop = 0;
  };
  quickBtn.addEventListener("click", () => show("quick"));
  fullBtn.addEventListener("click", () => show("full"));
  closeBtn.addEventListener("click", closeGuide);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGuide(); });

  panel.append(bar, scroll);
  overlay.append(panel);
  document.body.append(overlay);
  openEl = overlay;
  show(tab);
}

export function closeGuide(): void {
  if (openEl) { openEl.remove(); openEl = null; }
}
