# T3dassonne — Rules Reference

Authoritative summary compiled from the official Rio Grande / Hans im Glück rulebooks
(base game © 2000 HiG, The River © 2001/2006, River II via the "Count, King & Robber"
compendium). Figures are the C1 / original edition. Written for the implementation in
`src/engine`.

---

## Base game (72 tiles)

**Components**
- 72 land tiles total, including 1 starting tile (tile **D**: a city on one side, a
  straight road through the other two, field on the last).
- 8 followers per player; 1 is the score marker → **7 active followers each**.
- 2–5 players. Play proceeds clockwise.

**Turn sequence** (each turn, in order):
1. **Draw and place** one land tile. It must share at least one full edge with an existing
   tile, and **every abutting edge must match** (city↔city, road↔road, field↔field).
   Cloisters are self-contained.
2. **Optionally deploy one follower** from supply onto the tile just placed — but only on a
   feature whose entire connected component is currently **unoccupied** by any follower
   (yours or others').
3. **Score** any features **completed** by that placement; return the followers on them
   (except farmers).
4. If a drawn tile cannot be legally placed anywhere, discard it and draw another.

**Features & roles** — road → *thief*, city → *knight*, cloister → *monk*, field → *farmer*
(all the same physical follower).

**Scoring — completed features (during play)**
| Feature | Points |
|---|---|
| Road (both ends closed, or a loop) | **1 / tile** |
| City (fully walled, no gaps) | **2 / tile + 2 / pennant** |
| Cloister (all 8 neighbours present) | **9** (1 + 8) |

- Segments are never double-counted: a tile with two city segments still counts as **1 tile**.
- **Majority:** most followers on the feature takes **all** the points. On a **tie, every
  tied player scores the full value** (not split).

**Farms / fields (end of game only)**
- Not scored mid-game. At the end, for **each completed city** a farm borders, the player
  with the **most farmers** in that farm scores **3 points** (ties → each scores 3).
- Only **completed** cities count. A farmer is never returned to supply.

**Game end & final scoring** — the game ends when the last tile is placed. Then, for
**incomplete** features: road **1/tile**; city **1/tile + 1/pennant**; cloister **1 + present
neighbours**; then farms as above. Highest total wins (ties share the win).

---

## The River (12 tiles)

Terrain only — **no new scoring**; features on river tiles score exactly as normal.

- **Distribution:** 1 spring (source), 1 lake (end), 10 middle tiles (straights & curves,
  some carrying a road, a small city, or a cloister). Rivers run *through* the landscape;
  the water itself is **not** a scoreable feature and holds no follower.
- **Pre-game river phase:**
  1. Remove the base start tile. Place the **spring** in the centre as the start.
  2. Shuffle the river tiles and **play them all first**, before any land tiles; the **lake**
     ends the river.
  3. Each river tile must **connect the river** to the existing river (edge-matching).
  4. **No-U-turn rule:** a tile may not bend the river immediately back on itself (180°).
- Followers deploy **normally** on the land features of river tiles (never "on the river").
- The **field wraps around** the spring and the lake (each is one connected farm).

## The River II (12 tiles)

Also terrain only. Adds a **fork** and a **volcano lake**.

- **Special tiles:** 1 source, 1 **fork** (the river splits into two branches), 1 **lake with
  volcano** (the final tile). Other tiles are straights/curves, some with roads, a city, a
  cloister, or cosmetic **inn / pigsty / volcano** symbols (which only matter if you own the
  matching expansion — ignored here).
- **Placement:** the fork is played first (creating two river ends to grow); you may not make
  the river turn twice the same way, and **the two branches may not reconnect**.
- The **volcano lake** is placed last and takes **no follower**; it would spawn the dragon if
  Princess & Dragon were in play (cosmetic here).
- **Combining River I + II:** keep a single source; the fork's two branches are each closed by
  a lake.

---

## Implementation notes (T3dassonne)

- **River is a 4th edge type.** A river edge matches only another river edge; it acts as a
  **barrier for fields** (banks on opposite sides of the water are separate farms). The water
  carries no feature/segment — only the land features (fields, roads, cities, cloisters) on a
  river tile are scored, exactly like base tiles.
- The **river phase** runs before the land deck: the source is the start tile, the fork opens
  a second branch, and lakes close the branches. Standard edge-matching keeps the river
  connected; the digital build **relaxes** the no-U-turn / no-reconnect niceties (they only
  affect table space, which an infinite grid handles) to guarantee the river never soft-locks.
- Expansions beyond the Rivers (Inns & Cathedrals, King, Traders & Builders, Princess &
  Dragon, Tower, Cathars) are catalogued on the reference sheet but **not yet implemented**.
