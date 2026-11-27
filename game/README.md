# Game

Plain ES modules and Three.js from a CDN, with no build step.

- Run locally: `python3 -m http.server 8790 --bind 127.0.0.1` in this folder, then open http://127.0.0.1:8790/
- `src/sim.js`: the match logic (no rendering). `src/render.js`: the Three.js view. `src/config.js`: tunables and the roster.
- Models: `assets/models/<id>.glb` with clips named as in `CLIPS` (config.js) replace the procedural placeholders automatically.
- Smoke test: `node tests/sim-smoke.mjs`
- The game opens on the title menu: New game, Gamepad tutorial, Controls, Difficulty, Sound and Narration.
- Before kick-off, pick a kit, field and team size. For example, `?kit=blue&level=hard&size=3&field=meteora` selects three-a-side at Meteora. The other fields are `courtyard` and `winter`. The default is five-a-side in the courtyard. Rematch keeps these choices. Difficulty can also be changed from Pause.
- Open `?quality=low` on a slower phone for a smaller turf texture and shadow map, simpler arches and fewer spectators.
- Check the five match moves with `node tests/sim-moves.mjs`.
- Check the full-time statistics with `node tests/match-stats.mjs`.
- The full-time card counts a shot on target when it scores or the keeper saves it. Possession is each team's share of time controlling the ball. A pass completes on another teammate's first touch. Pass attempts include ground passes, lofted passes, one-twos and through balls.
- Check the advanced keyboard and gamepad moves with `node tests/advanced-controls.mjs`.
- With the game server running, test phone controls from the repo root with `node tools/playtest/cdp-playtest.mjs http://127.0.0.1:8790/ assets-src/screens/touch --touch`.
- Use `--kits` with the same playtest command to check both kit maps and measure torso brightness at kick-off, with the team rings hidden.
- Use `--flow` to check the first visit, both menu layouts, kit selection, replays and rematches.
