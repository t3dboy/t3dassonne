// ============================================================================
// Manual per-tile meeple-spot overrides.
//
// Positions are normalized 0..1 in the UNROTATED (rotation-0) tile frame, keyed
// by tile id then segment index. `computeMeepleSpot` looks these up first and
// falls back to the algorithmic placement (pole-of-inaccessibility / road-mid /
// field-centroid) for any segment without an override.
//
// Authored in the in-browser editor at /meeple-admin.html — click a segment,
// drag its marker on the tile, then "Copy JSON" and paste the `overrides` block
// below (and the notes are just for reference during that authoring pass).
// ============================================================================

export interface Spot { x: number; y: number; }

/** tileId -> segmentIndex -> spot (rotation-0, normalized 0..1). */
export const MEEPLE_SPOT_OVERRIDES: Record<string, Record<number, Spot>> = {
  A: { 1: { x: 0.494, y: 0.855 }, 2: { x: 0.165, y: 0.147 } },
  B: { 0: { x: 0.494, y: 0.516 }, 1: { x: 0.155, y: 0.155 } },
  D: { 0: { x: 0.857, y: 0.457 }, 2: { x: 0.19, y: 0.498 } },
  E: { 0: { x: 0.496, y: 0.169 }, 1: { x: 0.486, y: 0.799 } },
  F: { 0: { x: 0.473, y: 0.494 }, 1: { x: 0.499, y: 0.072 }, 2: { x: 0.496, y: 0.869 } },
  G: { 0: { x: 0.511, y: 0.447 }, 1: { x: 0.899, y: 0.46 }, 2: { x: 0.114, y: 0.475 } },
  H: { 0: { x: 0.782, y: 0.476 }, 1: { x: 0.218, y: 0.49 }, 2: { x: 0.5, y: 0.104 } },
  I: { 0: { x: 0.835, y: 0.402 }, 1: { x: 0.439, y: 0.793 }, 2: { x: 0.26, y: 0.253 } },
  J: { 0: { x: 0.503, y: 0.206 }, 1: { x: 0.614, y: 0.641 }, 2: { x: 0.881, y: 0.858 }, 3: { x: 0.153, y: 0.681 } },
  K: { 0: { x: 0.496, y: 0.173 }, 2: { x: 0.142, y: 0.858 }, 3: { x: 0.841, y: 0.682 } },
  L: { 0: { x: 0.489, y: 0.141 }, 1: { x: 0.806, y: 0.499 }, 2: { x: 0.509, y: 0.827 }, 3: { x: 0.213, y: 0.486 }, 4: { x: 0.84, y: 0.82 }, 5: { x: 0.189, y: 0.801 } },
  M: { 0: { x: 0.293, y: 0.307 } },
  N: { 0: { x: 0.295, y: 0.292 } },
  O: { 0: { x: 0.264, y: 0.256 }, 2: { x: 0.874, y: 0.835 } },
  P: { 0: { x: 0.313, y: 0.269 }, 2: { x: 0.862, y: 0.842 } },
  Q: { 0: { x: 0.473, y: 0.276 }, 1: { x: 0.485, y: 0.852 } },
  R: { 0: { x: 0.486, y: 0.234 }, 1: { x: 0.487, y: 0.845 } },
  S: { 0: { x: 0.497, y: 0.163 }, 2: { x: 0.772, y: 0.873 }, 3: { x: 0.222, y: 0.878 } },
  T: { 0: { x: 0.503, y: 0.147 } },
  U: { 1: { x: 0.138, y: 0.496 }, 2: { x: 0.852, y: 0.49 } },
  V: { 1: { x: 0.164, y: 0.853 }, 2: { x: 0.741, y: 0.23 } },
  W: { 3: { x: 0.865, y: 0.859 }, 4: { x: 0.159, y: 0.833 }, 5: { x: 0.498, y: 0.141 } },
  X: { 0: { x: 0.508, y: 0.185 }, 1: { x: 0.797, y: 0.504 }, 2: { x: 0.498, y: 0.8 }, 3: { x: 0.201, y: 0.494 }, 4: { x: 0.834, y: 0.184 }, 5: { x: 0.858, y: 0.84 }, 6: { x: 0.177, y: 0.821 }, 7: { x: 0.156, y: 0.169 } },
  RSRC: { 0: { x: 0.157, y: 0.797 } },
  RLAK: { 0: { x: 0.811, y: 0.221 } },
  RSTR: { 0: { x: 0.188, y: 0.476 }, 1: { x: 0.849, y: 0.526 } },
  RCRV: { 1: { x: 0.868, y: 0.122 } },
  RSTRC: { 0: { x: 0.843, y: 0.45 } },
};

/** Rotate a normalized rotation-0 spot to `rot` (each step = 90° clockwise). */
export function rotateSpot(p: Spot, rot: number): Spot {
  let x = p.x, y = p.y;
  const n = (((rot | 0) % 4) + 4) % 4;
  for (let i = 0; i < n; i++) { const nx = 1 - y, ny = x; x = nx; y = ny; }
  return { x, y };
}
