// ============================================================================
// Game settings — a small singleton persisted to localStorage, plus a compact
// wooden-styled settings overlay (matches the guide). Currently just the
// placement-hint toggle; add more rows here as needed.
// ============================================================================

import { el } from "./dom";

export interface GameSettings {
  placementHints: boolean; // yellow "where can this tile go" squares
}

const KEY = "t3d-settings";

function load(): GameSettings {
  let placementHints = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) placementHints = JSON.parse(raw).placementHints !== false;
  } catch { /* private mode / bad json */ }
  return { placementHints };
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): GameSettings { return current; }
export function onSettingsChange(fn: () => void): void { listeners.add(fn); }

function apply(patch: Partial<GameSettings>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
  listeners.forEach((f) => f());
}

let openEl: HTMLElement | null = null;

/** A labelled ON/OFF toggle row. */
function toggleRow(title: string, desc: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const row = el("div", { class: "settings-row" });
  const text = el("div", { class: "settings-text" }, [
    el("div", { class: "settings-label" }, [title]),
    el("div", { class: "settings-desc" }, [desc]),
  ]);
  const btn = el("button", { class: "settings-toggle" });
  const render = () => { const on = get(); btn.textContent = on ? "ON" : "OFF"; btn.classList.toggle("on", on); };
  btn.addEventListener("click", () => { set(!get()); render(); });
  render();
  row.append(text, btn);
  return row;
}

/** Open the settings overlay. */
export function openSettings(): void {
  closeSettings();
  const overlay = el("div", { class: "settings-overlay" });
  const panel = el("div", { class: "settings-panel" });

  const bar = el("div", { class: "settings-bar" });
  const close = el("button", { class: "guide-close" }, ["✕"]);
  bar.append(el("div", { class: "settings-title" }, ["Settings"]), close);

  const body = el("div", { class: "settings-body" });
  body.append(
    toggleRow(
      "Placement hints",
      "Show yellow squares where the current tile can be placed",
      () => current.placementHints,
      (v) => apply({ placementHints: v }),
    ),
  );

  panel.append(bar, body);
  overlay.append(panel);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
  close.addEventListener("click", closeSettings);
  document.body.append(overlay);
  openEl = overlay;
}

export function closeSettings(): void {
  if (openEl) { openEl.remove(); openEl = null; }
}
