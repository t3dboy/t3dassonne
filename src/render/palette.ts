// ============================================================================
// T3dassonne — colour palette. Tuned to resemble the real Carcassonne tiles:
// muted olive fields, pale sandy roads, warm-grey crenellated stone with
// terracotta roofs, heraldic-blue shields — rendered soft/painterly.
// Single source of truth for every colour used by the renderer & UI.
// ============================================================================

export const PALETTE = {
  // --- Grass / fields (Celeste greens, matched to the pixel tiles) ---------
  grassLight: "#9fd45a", // Celeste lit grass
  grassMid: "#4c8c32", // Celeste mid grass
  grassDark: "#356b2b", // Celeste shaded grass
  grassDeep: "#274d24", // Celeste deep shade / meadow base

  // --- Field trees & detail ------------------------------------------------
  treeGreen: "#4f7d33",
  treeDark: "#3a5f26",
  treeTrunk: "#79542d",

  // --- Roads (grey cobbled paths) ------------------------------------------
  roadLight: "#d5d2ca", // lit centre of the path
  roadMid: "#aeaaa0", // main grey path
  roadDark: "#847f74", // path border
  roadEdge: "#565247", // outline / rut

  // --- City stone walls ----------------------------------------------------
  stoneLight: "#ded6c1", // top-lit stone / merlons
  stoneMid: "#c4baa1", // mid stone
  stoneDark: "#9c917a", // shaded stone
  stoneShadow: "#71674f", // deepest shadow / mortar
  cityGround: "#e7d6a8", // warm cream ground inside the walls

  // --- Roofs (terracotta) --------------------------------------------------
  roofLight: "#db7d4c", // roof highlight
  roofMid: "#c05a30", // roof base red
  roofDark: "#96401f", // roof shadow

  // --- House walls (plaster) ----------------------------------------------
  houseWall: "#ecdcb2",
  houseWallDark: "#ccb480",
  window: "#463524", // dark window
  windowGlow: "#f4d888",

  // --- Water / river -------------------------------------------------------
  waterLight: "#8fd4e0", // rippled highlight
  waterMid: "#3ba0cf", // main river blue
  waterDeep: "#2273a0", // deep shading toward banks
  waterEdge: "#17567e", // darkest deep-water edge
  waterBank: "#6f8f5a", // muddy green bank where water meets grass

  // --- Field flowers / detail dots ----------------------------------------
  flowerWhite: "#f2eeda",
  flowerYellow: "#f2ce4c",
  flowerPink: "#e389af",
  flowerRed: "#d6544c",

  // --- Cloister / monastery -----------------------------------------------
  chapelWall: "#e7d6ac",
  chapelWallDark: "#c3ac7c",
  chapelRoof: "#b8532f", // red-tiled monastery roof
  chapelRoofDark: "#8d3c20",
  cross: "#f2e6c0",

  // --- Pennant / heraldic shield ------------------------------------------
  pennantField: "#34619c", // heraldic blue
  pennantEdge: "#e3c552", // gold trim
  pennantPole: "#6b4f2c",

  // --- Wood (bridges / UI) -------------------------------------------------
  woodLight: "#b98a52",
  woodMid: "#8a5f34",
  woodDark: "#5f3f22",
  woodTrim: "#3f2916",

  // --- Structural ----------------------------------------------------------
  outline: "#43351f", // soft dark-brown outline (not near-black)
  outlineSoft: "#5c4a30", // softer inner outline
  shadow: "rgba(40,28,14,0.26)", // soft drop shadow

  // --- Feedback ------------------------------------------------------------
  hintGold: "#f2c14e", // dashed placement hint
  highlight: "#fff2a8", // completed-feature glow
  highlightEdge: "#ffe066",
} as const;

export type PaletteKey = keyof typeof PALETTE;

/**
 * Five distinct meeple hues (base fill). Outlines are drawn separately.
 * Order = player 0..4.
 */
export const MEEPLE_COLORS: readonly string[] = [
  "#d94f4f", // 0 warm red
  "#3d7fc4", // 1 cornflower blue
  "#f0b429", // 2 golden yellow
  "#4faa5a", // 3 leafy green
  "#9b59b6", // 4 plum purple
] as const;

/** Slightly darker shade for a hex colour. */
export function shade(hex: string, amount = 0.72): string {
  const c = hex.replace("#", "");
  const r = Math.round(parseInt(c.slice(0, 2), 16) * amount);
  const g = Math.round(parseInt(c.slice(2, 4), 16) * amount);
  const b = Math.round(parseInt(c.slice(4, 6), 16) * amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}`;
}

/** Lighter tint of a hex colour. */
export function tint(hex: string, amount = 0.3): string {
  const c = hex.replace("#", "");
  const mix = (v: number) => Math.round(v + (255 - v) * amount);
  const r = mix(parseInt(c.slice(0, 2), 16));
  const g = mix(parseInt(c.slice(2, 4), 16));
  const b = mix(parseInt(c.slice(4, 6), 16));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}`;
}
