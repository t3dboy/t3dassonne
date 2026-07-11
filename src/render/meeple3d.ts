// ============================================================================
// T3dassonne — renders the meeple3d.stl model to 2D sprites with a tiny
// software 3D renderer (no dependencies). Each sprite is flat-shaded in a
// player colour and cached. Two poses:
//   - upright  → roads / cities / cloisters (a standing follower)
//   - laying   → farms (the follower lies on its back, as in real Carcassonne)
// If the model isn't loaded yet, callers fall back to the pixel silhouette.
// ============================================================================

interface Mesh {
  verts: Float32Array; // centred + unit-scaled, flat list of n*9 (3 verts * xyz)
  count: number;
}

let mesh: Mesh | null = null;
let loading = false;

/** Parse a binary STL into a centred, unit-scaled mesh (up-axis = +z). */
function parseBinarySTL(buf: ArrayBuffer): Mesh {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const verts = new Float32Array(n * 9);
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      const x = dv.getFloat32(p, true), y = dv.getFloat32(p + 4, true), z = dv.getFloat32(p + 8, true);
      verts[i * 9 + v * 3] = x;
      verts[i * 9 + v * 3 + 1] = y;
      verts[i * 9 + v * 3 + 2] = z;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
  const scale = 1 / Math.max(maxx - minx, maxy - miny, maxz - minz);
  for (let i = 0; i < verts.length; i += 3) {
    verts[i] = (verts[i] - cx) * scale;
    verts[i + 1] = (verts[i + 1] - cy) * scale;
    verts[i + 2] = (verts[i + 2] - cz) * scale;
  }
  return { verts, count: n };
}

/** Kick off async loading of the model (safe to call more than once). */
export function loadMeeple3D(): void {
  if (mesh || loading) return;
  loading = true;
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  fetch(base + "meeple3d.stl")
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("stl fetch failed"))))
    .then((buf) => { mesh = parseBinarySTL(buf); })
    .catch(() => { /* stay on the pixel-silhouette fallback */ })
    .finally(() => { loading = false; });
}

export function meepleModelReady(): boolean {
  return mesh !== null;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

const SPRITE = 132; // base sprite resolution (blitted scaled at draw time)
const spriteCache = new Map<string, HTMLCanvasElement>();

// Pose rotations (pitch around model X, yaw around model Z). Tuned so the
// follower reads as a little 3D figure viewed from slightly above.
const POSE = {
  upright: { pitch: 0.1, yaw: 0.12, roll: 0 }, // standing, viewed front, slight 3/4
  laying: { pitch: 0.1, yaw: 0.12, roll: Math.PI / 2 }, // rolled onto its back
};

/** Render (and cache) the meeple sprite for a colour + pose. Returns null until
 *  the model has loaded. */
export function getMeepleSprite(color: string, laying: boolean): HTMLCanvasElement | null {
  if (!mesh) return null;
  const key = `${color}|${laying ? 1 : 0}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const { pitch, yaw, roll } = laying ? POSE.laying : POSE.upright;
  const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const V = mesh.verts;
  const n = mesh.count;

  // rotate every vertex once; screen = (x,-z) rolled about the view axis; the
  // depth axis (y, camera along +y) is used for painter's ordering & normals.
  const rx = new Float32Array(n * 9); // rotated 3D
  const spx = new Float32Array(n * 3); // pre-fit screen x
  const spy = new Float32Array(n * 3); // pre-fit screen y
  let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
  for (let i = 0; i < n * 3; i++) {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    const x1 = x * cyaw - y * syaw, y1 = x * syaw + y * cyaw, z1 = z; // yaw about Z
    const x2 = x1, y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp; // pitch about X
    rx[i * 3] = x2; rx[i * 3 + 1] = y2; rx[i * 3 + 2] = z2;
    const s0 = x2, t0 = -z2;
    const sx = s0 * cr - t0 * sr, syy = s0 * sr + t0 * cr; // roll
    spx[i] = sx; spy[i] = syy;
    if (sx < minSx) minSx = sx; if (sx > maxSx) maxSx = sx;
    if (syy < minSy) minSy = syy; if (syy > maxSy) maxSy = syy;
  }
  const fit = (SPRITE * 0.9) / Math.max(maxSx - minSx, maxSy - minSy);
  const ox = SPRITE / 2 - ((minSx + maxSx) / 2) * fit;
  const oy = SPRITE / 2 - ((minSy + maxSy) / 2) * fit;

  // painter's order: far (large depth y) first
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) depth[i] = (rx[i * 9 + 1] + rx[i * 9 + 4] + rx[i * 9 + 7]) / 3;
  order.sort((a, b) => depth[b] - depth[a]);

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE;
  canvas.height = SPRITE;
  const ctx = canvas.getContext("2d")!;
  const [br, bg, bb] = hexToRgb(color);
  // light from the upper-front-left (screen space: x right, y depth(-=toward cam), z up)
  const L = [-0.35, -0.55, 0.76];

  // soft ground shadow at the base of the standing pose
  if (!laying) {
    ctx.fillStyle = "rgba(20,14,8,0.22)";
    ctx.beginPath();
    ctx.ellipse(SPRITE / 2, oy + maxSy * fit, SPRITE * 0.24, SPRITE * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const i of order) {
    // face normal from the rotated 3D triangle (roll doesn't affect lighting)
    const ax = rx[i * 9], ay = rx[i * 9 + 1], az = rx[i * 9 + 2];
    const bx = rx[i * 9 + 3], by = rx[i * 9 + 4], bz = rx[i * 9 + 5];
    const gx = rx[i * 9 + 6], gy2 = rx[i * 9 + 7], gz = rx[i * 9 + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = gx - ax, vy = gy2 - ay, vz = gz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const sh = 0.42 + 0.58 * diff;
    ctx.fillStyle = `rgb(${Math.round(br * sh)},${Math.round(bg * sh)},${Math.round(bb * sh)})`;
    const i3 = i * 3;
    ctx.beginPath();
    ctx.moveTo(spx[i3] * fit + ox, spy[i3] * fit + oy);
    ctx.lineTo(spx[i3 + 1] * fit + ox, spy[i3 + 1] * fit + oy);
    ctx.lineTo(spx[i3 + 2] * fit + ox, spy[i3 + 2] * fit + oy);
    ctx.closePath();
    ctx.fill();
  }

  spriteCache.set(key, canvas);
  return canvas;
}

export function clearMeepleSpriteCache(): void {
  spriteCache.clear();
}
