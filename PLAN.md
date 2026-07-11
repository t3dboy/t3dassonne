# T3dassonne — Build Plan

A browser-based **Carcassonne** for iPhone-sized screens (landscape + portrait), styled after **Stardew Valley** (cozy pixel art, warm palette, chunky UI). Vanilla **TypeScript + Vite + Canvas2D** (matches the T3d house stack). No external asset downloads — all tile art is drawn procedurally in pixel-art style, all audio is synthesized with WebAudio.

## Modes
- **Vs Computer** — 1 human vs 1–3 AI opponents.
- **Pass & Play** — 2–5 local players sharing one phone, with a "pass the phone" hand-off screen between turns.

## Gameplay scope (base game, fully featured)
- 72-tile base deck (24 tile types A–X with correct distribution), starting tile D.
- Tile draw → rotate → place (edge-matching validation) → optional meeple placement → score completed features → return meeples.
- Features: **roads**, **cities** (with pennants/shields), **cloisters/monasteries**, **farms/fields** (farmers).
- Scoring: roads 1/tile; cities 2/tile + 2/pennant (half when incomplete at end); cloister 1 + 8 neighbours; farms 3 pts per completed city a field touches (end only). Meeple majority resolves feature ownership (ties share).
- 7 meeples per player. End-game scoring for incomplete features.

## Visual style (Stardew Valley)
- Warm, saturated pixel art. Grass greens (#6ab04c-ish), dirt roads (#a5744a), stone-grey city walls with terracotta-red roofs, wood UI panels with dark outlines, soft drop shadows. Pixel font feel. Chunky rounded wood buttons.

## Architecture / ownership (parallel agents)
- **src/core/** (me) — `types.ts` shared contract, `tiles.ts` canonical tile data. Foundation.
- **src/engine/** (Agent 1) — pure rules: placement legality, union-find feature graph, scoring, turn/game state machine. Owns finalizing `tiles.ts` segments.
- **src/render/** (Agent 2) — pixel-art tile drawing, meeples, board, camera, highlights. Stardew palette. + standalone art-preview page.
- **src/audio/** (Agent 3) — WebAudio synthesized SFX (place, rotate, meeple, score, invalid, button, victory) + cozy looping music. `sound.play(name)` API.
- **src/ai/** (Agent 4) — opponent move selection (tile placement + meeple) against engine interface.
- **src/ui/** + **src/main.ts** (me) — screens (menu, mode/player select, hand-off), in-game HUD, input (pan/zoom/tap), responsive layout, wiring, browser test & polish.

## Coordinate model
- Infinite integer grid, `Map<"x,y", PlacedTile>`. Sides indexed N=0 E=1 S=2 W=3. Farm half-edges 0–7 clockwise from north-west. Camera = {offsetX, offsetY, scale}.
