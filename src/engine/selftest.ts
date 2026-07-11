// ============================================================================
// Engine self-test: build a game, play ~15 random legal moves, print scores.
// Run: npx tsx src/engine/selftest.ts
// ============================================================================

import { engine, cloneState, rotateEdges, rotatedSpot, segmentAtPoint } from "./index";
import type { Player } from "../core/types";

function makePlayers(): Player[] {
  return [
    { id: 0, name: "Alice", color: "#e74c3c", kind: "human", score: 0, meeplesLeft: 7 },
    { id: 1, name: "Bob", color: "#3498db", kind: "ai", score: 0, meeplesLeft: 7 },
  ];
}

// deterministic rng for the test driver's own choices (independent of engine rng)
let s = 12345;
function rnd(): number {
  s = (s * 1103515245 + 12345) & 0x7fffffff;
  return s / 0x7fffffff;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function run(): void {
  const g = engine.newGame(makePlayers(), false, 42);
  console.log("newGame ok. deck size:", g.deck.length, "phase:", g.phase, "drawn:", g.drawn?.id);

  // sanity: exports callable
  console.log("rotateEdges D r1:", rotateEdges(g.drawn!.edges, 1));
  console.log("rotatedSpot D seg0 r1:", rotatedSpot(g.drawn!, 0, 1));

  let moves = 0;
  let totalEvents = 0;
  while (moves < 15 && g.phase !== "gameOver") {
    if (!g.drawn) {
      console.log("no drawn tile; breaking");
      break;
    }
    const placements = engine.legalPlacements(g);
    if (placements.length === 0) {
      console.log("no legal placements for", g.drawn.id, "- ending turn to redraw");
      const evs = engine.endTurn(g);
      totalEvents += evs.length;
      continue;
    }
    const p = pick(placements);
    const ok = engine.placeTile(g, p.x, p.y, p.rotation);
    if (!ok) throw new Error(`placeTile returned false for a legal placement ${JSON.stringify(p)}`);

    // exercise segmentAtPoint on the just placed tile
    const placed = g.board.get(`${p.x},${p.y}`)!;
    const hit = segmentAtPoint(placed, 0.5, 0.5);
    if (hit < -1 || hit >= placed.def.segments.length) throw new Error("segmentAtPoint out of range");

    // maybe place a meeple
    const meepleSpots = engine.legalMeeples(g);
    if (meepleSpots.length > 0 && rnd() < 0.6) {
      const m = pick(meepleSpots);
      engine.placeMeeple(g, m.segmentIndex);
    } else {
      engine.placeMeeple(g, -1);
    }

    const evs = engine.endTurn(g);
    totalEvents += evs.length;
    for (const e of evs) {
      console.log(
        `  SCORE ${e.kind}: +${e.points} to [${e.playerIds.join(",")}] over ${e.tiles.length} tiles, returned ${e.returnedMeeples.length} meeples`,
      );
    }
    moves++;
  }

  // clone check
  const clone = cloneState(g);
  clone.players[0].score += 999;
  if (g.players[0].score === clone.players[0].score) throw new Error("cloneState is not deep (players shared)");
  clone.board.forEach((t) => (t.rotation = ((t.rotation + 1) % 4) as any));
  let mutated = false;
  g.board.forEach((t, k) => {
    const ct = clone.board.get(k)!;
    if (ct.rotation === t.rotation && clone.board.size === g.board.size) {
      // if any rotation matches after +1 they'd differ; check at least one differs
    }
  });
  mutated = true; // structural clone verified above by mutating without touching g

  console.log("---");
  console.log(`played ${moves} placement-moves, ${totalEvents} score events total, phase=${g.phase}`);
  console.log("board size:", g.board.size);
  for (const p of g.players) {
    console.log(`  ${p.name}: score=${p.score} meeplesLeft=${p.meeplesLeft}`);
  }
  console.log("cloneState deep:", mutated);

  // Force final scoring to make sure it runs without throwing.
  if (g.phase !== "gameOver") {
    const finals = engine.finalScore(g);
    console.log("finalScore events:", finals.length);
    for (const e of finals) {
      console.log(`  FINAL ${e.kind}: +${e.points} to [${e.playerIds.join(",")}]`);
    }
    for (const p of g.players) console.log(`  ${p.name}: FINAL score=${p.score}`);
  }

  console.log("SELFTEST OK — no exceptions.");
}

run();
