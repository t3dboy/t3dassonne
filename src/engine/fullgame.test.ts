// Headless full-game smoke test: AI plays every seat to exhaustion.
import { engine } from "./index";
import { chooseTurn } from "../ai";
import type { Player } from "../core/types";

function run(seed: number) {
  const players: Player[] = [
    { id: 0, name: "A", color: "#f00", kind: "ai", score: 0, meeplesLeft: 7 },
    { id: 1, name: "B", color: "#00f", kind: "ai", score: 0, meeplesLeft: 7 },
  ];
  const g = engine.newGame(players, false, seed);
  let guard = 0;
  let scoringEvents = 0;
  while (g.phase !== "gameOver" && guard++ < 500) {
    if (!g.drawn) break;
    const legal = engine.legalPlacements(g);
    if (legal.length === 0) {
      // shouldn't happen, but advance defensively
      const ev = engine.endTurn(g);
      scoringEvents += ev.length;
      continue;
    }
    const turn = chooseTurn(engine, g, "hard");
    if (!engine.placeTile(g, turn.placement.x, turn.placement.y, turn.placement.rotation)) {
      engine.placeTile(g, legal[0].x, legal[0].y, legal[0].rotation);
    }
    engine.placeMeeple(g, turn.meepleSegmentIndex);
    const ev = engine.endTurn(g);
    scoringEvents += ev.length;
  }
  const finals = engine.finalScore(g);
  scoringEvents += finals.length;
  return {
    seed,
    tiles: g.board.size,
    deckLeft: g.deck.length,
    phase: g.phase,
    scoringEvents,
    scores: g.players.map((p) => `${p.name}:${p.score}(${p.meeplesLeft}m)`).join(" "),
  };
}

for (const seed of [1, 42, 1234, 99999]) {
  const r = run(seed);
  const total = r.scores;
  console.log(
    `seed ${r.seed}: ${r.tiles} tiles, deckLeft ${r.deckLeft}, phase ${r.phase}, events ${r.scoringEvents}, ${total}`
  );
  if (r.phase !== "gameOver") console.log("  !! did not reach gameOver");
}
console.log("full-game test complete");
