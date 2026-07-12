// Tiny DOM helpers for building the Stardew-styled UI.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  cls = "btn"
): HTMLButtonElement {
  const b = el("button", { class: cls }, [label]);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Live env(safe-area-inset-*) in CSS px (0 where not applicable). Used to push
// the canvas HUD/menu clear of the iPhone status bar / Dynamic Island (top) and
// the home indicator (bottom). Measured via hidden probes so they also reflect
// the current device on rotation.
function _probe(which: "top" | "bottom"): number {
  let p = _probes[which];
  if (!p) {
    p = document.createElement("div");
    p.style.cssText = `position:fixed;${which}:0;left:0;width:0;height:env(safe-area-inset-${which},0px);pointer-events:none;visibility:hidden;`;
    document.body.appendChild(p);
    _probes[which] = p;
  }
  return p.getBoundingClientRect().height || 0;
}
const _probes: { top?: HTMLDivElement; bottom?: HTMLDivElement } = {};
export function safeAreaTop(): number { return _probe("top"); }
export function safeAreaBottom(): number { return _probe("bottom"); }
