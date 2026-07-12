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

// Live env(safe-area-inset-top) in CSS px (0 where not applicable). Used to push
// the canvas HUD/menu below the iPhone status bar / Dynamic Island. Measured via
// a hidden probe so it also updates on rotation.
let _safeProbe: HTMLDivElement | null = null;
export function safeAreaTop(): number {
  if (!_safeProbe) {
    _safeProbe = document.createElement("div");
    _safeProbe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden;";
    document.body.appendChild(_safeProbe);
  }
  return _safeProbe.getBoundingClientRect().height || 0;
}
