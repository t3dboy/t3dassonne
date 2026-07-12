// ============================================================================
// T3dassonne — tiny pixel feature icons (road / city / cloister / field) for the
// end-game score round-up. Same crisp/limited-palette pixel look as the tiles.
// Each icon is a 14x14 pixel map, rendered once to an offscreen canvas and
// cached; blit it unsmoothed (or use image-rendering: pixelated on an <img>).
// ============================================================================

const S = 14;

// colour legend — matches the pixel tile palette
const COL: Record<string, string> = {
  X: "#2b2138", // outline (dark plum)
  r: "#cdb079", l: "#ecdcab", R: "#a5854f", d: "#6f5232", // road / door
  f: "#cd5330", F: "#94331d", w: "#d8b779", W: "#a9824f", // city roof / wall
  c: "#ecd6a2", C: "#c74f33", "+": "#f4e6b4", // chapel wall / roof / cross
  g: "#6cae3c", h: "#9fd45a", G: "#356b2b", // grass
};

const MAPS: Record<string, string[]> = {
  // a tan path running across, with a dashed centre line
  road: [
    "..............",
    "..............",
    "..............",
    "..............",
    "XXXXXXXXXXXXXX",
    "rrrrrrrrrrrrrr",
    "llRRllRRllRRll",
    "rrrrrrrrrrrrrr",
    "XXXXXXXXXXXXXX",
    "..............",
    "..............",
    "..............",
    "..............",
    "..............",
  ],
  // a red-roofed house
  city: [
    "......XX......",
    ".....XffX.....",
    "....XffffX....",
    "...XffffffX...",
    "..XffffffffX..",
    ".XffffffffffX.",
    "XFFFFFFFFFFFFX",
    ".XwwwwwwwwwwX.",
    ".XwwwwddwwwwX.",
    ".XwwwwddwwwwX.",
    ".XwwwwddwwwwX.",
    ".XXXXXXXXXXXX.",
    "..............",
    "..............",
  ],
  // a chapel with a cross on top
  cloister: [
    "......+.......",
    "......+.......",
    "....++++++....",
    "......+.......",
    ".....XXXX.....",
    "....XCCCCX....",
    "...XCCCCCCX...",
    "..XXXXXXXXXX..",
    "..XccccccccX..",
    "..XcccddcccX..",
    "..XcccddcccX..",
    "..XXXXXXXXXX..",
    "..............",
    "..............",
  ],
  // three tufts of grass — the farm/field
  field: [
    "..............",
    "..............",
    "...h......h...",
    "...h...h..h...",
    "..hg..hg.hg...",
    "..hg..hg.gg...",
    "..gg..gg.gg...",
    "..gg..gg.gg...",
    ".hgg..gg.ggh..",
    ".ggg.hgg.ggg..",
    ".gggggggggggg.",
    ".GGGGGGGGGGGG.",
    "..............",
    "..............",
  ],
};

const cache = new Map<string, HTMLCanvasElement>();

/** Cached 14x14 pixel icon canvas for a feature kind. */
export function featureIconCanvas(kind: string): HTMLCanvasElement {
  const k = kind in MAPS ? kind : "field";
  const hit = cache.get(k);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  const map = MAPS[k];
  for (let y = 0; y < map.length; y++)
    for (let x = 0; x < map[y].length; x++) {
      const col = COL[map[y][x]];
      if (col) { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); }
    }
  cache.set(k, c);
  return c;
}

/** Same icon as a data URL (for an <img> in the score UI). */
export function featureIconDataUrl(kind: string): string {
  return featureIconCanvas(kind).toDataURL();
}
