# Why this is vendored instead of an npm dependency

`omniwaifu/pixi-live2d5` (https://github.com/omniwaifu/pixi-live2d5) isn't
published to npm -- it's a source-only fork, and its own build needs Bun.
This folder is a pre-built copy (`dist/index.js` + `dist/index.es.js`,
built with plain `node scripts/build.js`, no Bun required) so `npm install`
in the main project just works.

If you want to update it later: `git clone --recursive
https://github.com/omniwaifu/pixi-live2d5.git`, `npm install --legacy-peer-deps`
(plain npm install may hit an unrelated arborist bug -- `--legacy-peer-deps`
sidesteps it), `node scripts/build.js`, then copy the two `dist/index*.js`
files here.

Why this fork at all: it's built and tested specifically against Cubism
Core 6.0.1, which is what Live2D's site currently serves. The original
`pixi-live2d-display` (and its lipsyncpatch fork) predate that Core release
and crash against it -- see CLAUDE.md / project history for the specific
error and the open upstream issue.

Trade-off: this fork dropped the `speak()` convenience method the other
library had, so `src/main.ts` drives lipsync manually via a Web Audio
AnalyserNode instead.
