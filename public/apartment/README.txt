Drop your prebuilt apartment model here as
twokinds_modern_trio_apartment.glb (matching MODEL_PATH in
src/apartment/index.ts) -- or edit that constant to match whatever
filename/model you're actually using.

Round 12 replaced the hand-authored procedural room (walls, furniture,
and materials all generated in code) with a single prebuilt glTF binary
loaded through the same GLTFLoader the VRM avatar already uses. See
docs/DECISIONS.md's round-12 entry for the full story of why, and
src/apartment/floorplan.ts's top comment for what's known and not known
about room layout, doors, and furniture positions in whatever model you
put here.

If you swap in a different model, floorplan.ts's FOOTPRINT/CEILING_H/
ANCHORS are sized to the round-12 model's specific measured bounding box
-- a differently-sized model will need those numbers redone to match
(the file's own comments explain where those specific numbers came from
and how to get new ones: `npx @gltf-transform/cli inspect <file>.glb`
reports the bounding box directly).

This directory is otherwise empty and gitignored (see .gitignore) --
your model is yours, not something to commit into this repo.
