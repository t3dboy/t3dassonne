// Full-screen menu / setup / hand-off / game-over screens (DOM overlay).
import { el, button, clear } from "./dom";
import type { Difficulty } from "../ai";

export const PLAYER_COLORS = [
  "#d4453a", // red
  "#3a72d4", // blue
  "#57b04a", // green
  "#f2c14e", // yellow
  "#9b59b6", // purple
];
export const PLAYER_NAMES = ["Red", "Blue", "Green", "Gold", "Violet"];

export type Mode = "ai" | "pass";

export interface PlayerConfig {
  name: string;
  color: string;
  kind: "human" | "ai";
}
export interface MatchConfig {
  mode: Mode;
  players: PlayerConfig[];
  difficulty: Difficulty;
  passAndPlay: boolean;
  river: boolean;
}

export function showMenu(root: HTMLElement, cb: { onPlay: (m: Mode) => void }) {
  clear(root);
  const screen = el("div", { class: "screen" });
  screen.append(
    el("div", { class: "title" }, ["T3dassonne"]),
    el("div", { class: "subtitle" }, ["a cozy tile-laying kingdom"])
  );
  const panel = el("div", { class: "panel" });
  panel.append(
    button("Play vs Computer", () => cb.onPlay("ai"), "btn gold"),
    button("Pass & Play (local)", () => cb.onPlay("pass"), "btn")
  );
  screen.append(panel);
  screen.append(el("div", { class: "subtitle" }, ["Base game · 72 tiles"]));
  root.append(screen);
}

export function showSetup(
  root: HTMLElement,
  mode: Mode,
  cb: { onStart: (m: MatchConfig) => void; onBack: () => void }
) {
  clear(root);
  const screen = el("div", { class: "screen" });
  screen.append(el("div", { class: "title" }, [mode === "ai" ? "Vs Computer" : "Pass & Play"]));

  const panel = el("div", { class: "panel" });

  // player count
  let count = mode === "ai" ? 2 : 2;
  const maxP = 5;
  const minP = 2;
  const countRow = el("div", { class: "row" });
  const countLabel = el("div", { class: "label" }, []);
  const renderCount = () => {
    countLabel.textContent =
      mode === "ai"
        ? `Players: ${count}  (you + ${count - 1} AI)`
        : `Players: ${count}`;
    [...countRow.children].forEach((c, i) => {
      c.classList.toggle("sel", i + minP === count);
    });
  };
  for (let n = minP; n <= maxP; n++) {
    countRow.append(
      button(String(n), () => {
        count = n;
        renderCount();
      }, "btn small")
    );
  }

  // difficulty (ai only)
  let difficulty: Difficulty = "normal";
  const diffRow = el("div", { class: "row" });
  const diffs: Difficulty[] = ["easy", "normal", "hard"];
  const renderDiff = () => {
    [...diffRow.children].forEach((c, i) =>
      c.classList.toggle("sel", diffs[i] === difficulty)
    );
  };
  diffs.forEach((d) =>
    diffRow.append(
      button(d[0].toUpperCase() + d.slice(1), () => {
        difficulty = d;
        renderDiff();
      }, "btn small")
    )
  );

  // river toggle
  let withRiver = true;
  const riverRow = el("div", { class: "row" });
  const renderRiver = () => {
    [...riverRow.children].forEach((c, i) => c.classList.toggle("sel", (i === 0) === withRiver));
  };
  riverRow.append(
    button("On", () => { withRiver = true; renderRiver(); }, "btn small"),
    button("Off", () => { withRiver = false; renderRiver(); }, "btn small")
  );

  panel.append(el("div", { class: "label" }, ["How many players?"]), countLabel, countRow);
  if (mode === "ai") {
    panel.append(el("div", { class: "label" }, ["AI difficulty"]), diffRow);
  }
  panel.append(el("div", { class: "label" }, ["The River (start with a river)"]), riverRow);

  const start = button("Start Game ▶", () => {
    const players: PlayerConfig[] = [];
    for (let i = 0; i < count; i++) {
      const isAI = mode === "ai" && i > 0;
      players.push({
        name: isAI ? `AI ${i}` : PLAYER_NAMES[i],
        color: PLAYER_COLORS[i],
        kind: isAI ? "ai" : "human",
      });
    }
    cb.onStart({ mode, players, difficulty, passAndPlay: mode === "pass", river: withRiver });
  }, "btn gold");

  screen.append(panel, start, button("← Back", cb.onBack, "btn ghost"));
  root.append(screen);
  renderCount();
  renderDiff();
  renderRiver();
}

export function showHandoff(
  root: HTMLElement,
  name: string,
  color: string,
  onReady: () => void
) {
  clear(root);
  const screen = el("div", { class: "screen" });
  const dot = el("div", { class: "dot", style: `width:64px;height:64px;background:${color}` });
  screen.append(
    el("div", { class: "title" }, ["Pass the phone"]),
    dot,
    el("div", { class: "subtitle" }, [`Hand to ${name}`]),
    button("I'm ready ▶", onReady, "btn gold")
  );
  root.append(screen);
}

export interface FinalResult {
  name: string;
  color: string;
  score: number;
}
export function showGameOver(
  root: HTMLElement,
  results: FinalResult[],
  cb: { onRematch: () => void; onMenu: () => void }
) {
  clear(root);
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const screen = el("div", { class: "screen" });
  screen.append(el("div", { class: "title" }, [sorted[0].name + " wins!"]));
  const panel = el("div", { class: "panel" });
  sorted.forEach((r, i) => {
    const row = el("div", { class: "row", style: "justify-content:space-between;align-items:center" });
    row.append(
      el("div", { class: "label" }, [
        el("span", { class: "dot", style: `display:inline-block;background:${r.color};margin-right:8px;vertical-align:middle` }),
        `${i + 1}. ${r.name}`,
      ]),
      el("div", { class: "label" }, [`${r.score} pts`])
    );
    panel.append(row);
  });
  screen.append(
    panel,
    button("Rematch ↻", cb.onRematch, "btn gold"),
    button("Main Menu", cb.onMenu, "btn ghost")
  );
  root.append(screen);
}
