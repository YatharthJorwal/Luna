#!/usr/bin/env node
// Launches the same two processes `npm run tauri dev` gets for free from
// src-tauri/src/lib.rs's spawn_backend_processes() -- vite (the frontend)
// and the orchestrator (Python/uvicorn) -- for sandbox-only testing,
// where there's no Tauri/Rust process around to spawn the orchestrator
// for you. Without this, `npm run sandbox` alone never starts the
// orchestrator at all: testing the sandbox scene either needs a separate
// manual `python app.py` in a third terminal, or -- what actually
// happened, per the user's own report -- silently ends up talking to
// whatever orchestrator instance (possibly stale, from an earlier
// `tauri dev` run) already happens to be bound to the port.
//
// GPT-SoVITS is deliberately NOT spawned here -- it's a separate, heavier
// server (its own venv, its own model weights) that lib.rs already starts
// once for the whole app; `orchestrator/tts.py` falls back to pyttsx3
// automatically if it isn't reachable (see docs/DECISIONS.md), so
// sandbox-only testing works fine without it, just with a lower-quality
// voice. Start it yourself first if you want the real one.
//
// Ctrl+C here kills both children (see the SIGINT/SIGTERM handling
// below, and each child's own "exit" listener in case one dies on its
// own) -- and even if that somehow doesn't reach one of them (Windows'
// Ctrl+C-to-process-group behavior isn't something this script can fully
// guarantee without a real Windows machine to test against -- see
// docs/DECISIONS.md), orchestrator/app.py's own pidfile takeover means
// the *next* run cleans up any leftover instance itself either way. This
// script and that fix are deliberately two independent layers, neither
// relying on the other to work.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const orchestratorDir = path.join(repoRoot, "orchestrator");
const isWindows = process.platform === "win32";
const venvPython = path.join(
  orchestratorDir,
  "venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python",
);

const children = [];
let shuttingDown = false;

function spawnChild(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  child.on("exit", (code) => {
    // One child exiting on its own (a crash, or vite's own restart
    // machinery misbehaving) takes the other down with it too, rather
    // than leaving a lone half-working process running -- same
    // "no orphans" principle as the pidfile takeover in app.py.
    if (!shuttingDown) {
      console.log(`[luna] ${command} exited (code ${code}) -- shutting down the rest`);
      shutdown();
    }
  });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

if (!existsSync(venvPython)) {
  console.error(
    `[luna] ${venvPython} not found -- orchestrator venv not set up yet? ` +
      "Run `pip install -r requirements.txt` inside orchestrator/venv first.",
  );
  console.error("[luna] starting vite anyway, without the orchestrator -- chat/voice won't work this run.");
}

spawnChild("npx", ["vite", "--open", "/sandbox.html"], { cwd: repoRoot, shell: isWindows });
if (existsSync(venvPython)) {
  spawnChild(venvPython, ["app.py"], { cwd: orchestratorDir });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
