Drop VRM Animation (.vrma) files here to use them in the sandbox
(sandbox.html / src/sandbox.ts) instead of its built-in procedural walk
fallback.

Currently looked for:
  walk.vrma  -- a looping walk cycle, played while she's moving and
                paused (frozen on its current pose) while she's standing
                still. See src/sandbox.ts's WALK_CLIP_PATH.

Without it, the sandbox animates a code-driven approximation instead
(sine-wave leg/arm swing, no asset required) so locomotion, camera, and
room work can be tested before any real animation exists. Drop a real
export in and reload -- no code changes needed.

Where to get one: VRoid Hub / Mixamo-to-VRMA conversion tools, or any
VRM Animation exporter that targets the VRMC_vrm_animation extension.
Not something this repo can generate -- same situation as
public/vrm/luna.vrm.

This directory is otherwise empty and gitignored (see .gitignore) --
these are your own sourced/licensed assets, not something to commit into
this repo.
