// Talks to the Python orchestrator (orchestrator/app.py) over a small JSON
// protocol. Phase 1 only needed two message shapes; Phase 2.5 adds voice
// input (user_audio / transcript); a later round adds a "stop" button;
// Phase 8 adds `emotion` on `turn_end`; the full-body sandbox round adds a
// `surface` identifier on connect and a `surface_status` reply, so two
// windows (the desktop shell and the sandbox) talking to the same
// orchestrator at once don't both try to drive the same conversation --
// see that message's own comment below and docs/DECISIONS.md:
//
//   -> { type: "user_text", text: string }
//   -> { type: "user_audio", audio_b64: string }
//   -> { type: "stop" }
//   <- { type: "speak", text: string, audio_b64: string, mime: string }
//   <- { type: "transcript", text: string }
//   <- { type: "turn_end", emotion?: string }
//   <- { type: "surface_status", role: "driver" | "observer" }
//
// `transcript` is sent once per `user_audio` message, always -- an empty
// `text` means the orchestrator heard nothing intelligible (silence, noise),
// which is distinct from a connection problem. `turn_end` is sent once a
// reply is fully done generating, whether it finished normally or was cut
// short by a `stop` -- the frontend uses it to know when to re-enable input
// and hide the stop button, since queued audio finishing playback isn't the
// same signal (more chunks could still be on the way when audio catches up).
// `emotion`, when present, is one of the six VRM expression names main.ts's
// emotion-blend system knows about (see orchestrator/persona.py's
// VALID_EMOTIONS) -- omitted (not a guessed default) whenever the LLM's own
// reply didn't produce a recognizable tag, or the turn never got that far
// (LLM unreachable, stopped mid-generation) -- the frontend leaves whatever
// expression she's already wearing alone in that case, rather than snapping
// to something arbitrary. Delivered once per whole turn, not per `speak`
// chunk -- an early design considered tagging every sentence individually,
// but that's a much heavier compliance ask for a small model for very
// little benefit, since the blend itself is what makes expression changes
// look gradual, not the tagging granularity.
//
// `surface_status`: whichever window connects first becomes the "driver"
// (the one actually allowed to start turns); a second window connecting
// while the first is still open becomes an "observer" -- sent a
// `surface_status` with role "observer" right after connecting, and gets a
// canned in-character decline (not silence) if it tries to send
// `user_text`/`user_audio` anyway, rather than either window's TTS audio
// silently overlapping the other's. If the driver disconnects, the
// orchestrator promotes the next still-open connection (if any) and sends
// it a fresh `surface_status` with role "driver" -- see app.py's
// `ws_endpoint` for the actual promotion logic. Each connection still has
// its own conversation history (unchanged since Phase 2), so a promoted
// observer starts a fresh conversation rather than inheriting the old
// driver's mid-conversation state -- a known, accepted limitation, not an
// oversight; see docs/DECISIONS.md.

const ORCHESTRATOR_URL = "ws://127.0.0.1:8765/ws";
const RECONNECT_DELAY_MS = 2000;

export type SpeakMessage = {
  type: "speak";
  text: string;
  audio_b64: string;
  mime: string;
};

export type TranscriptMessage = {
  type: "transcript";
  text: string;
};

export type TurnEndMessage = {
  type: "turn_end";
  emotion?: string;
};

export type SurfaceRole = "driver" | "observer";

export type SurfaceStatusMessage = {
  type: "surface_status";
  role: SurfaceRole;
};

export type ConnectionState = "offline" | "connected" | "listening";

interface WsClientOptions {
  /** Identifies which window this connection is from -- "shell" for the
   * Tauri desktop pet (src/main.ts), "sandbox" for the full-body sandbox
   * (src/sandbox.ts). Purely informational on the wire (a query param the
   * orchestrator can log/key off of); the driver/observer decision itself
   * is "whoever connected first," not based on which surface name this is
   * -- see this file's own top-of-file comment. */
  surface: "shell" | "sandbox";
  onSpeak: (msg: SpeakMessage) => void;
  onTranscript: (msg: TranscriptMessage) => void;
  onTurnEnd: (emotion?: string) => void;
  onStateChange: (state: ConnectionState) => void;
  /** Optional since it's new -- a caller that doesn't care about
   * driver/observer status (there isn't one today, but keeping this
   * optional rather than required avoids forcing every future caller to
   * handle a concern that may not apply to it) can simply omit it. */
  onSurfaceStatus?: (role: SurfaceRole) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private opts: WsClientOptions;
  private reconnectTimer: number | undefined;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    const url = `${ORCHESTRATOR_URL}?surface=${encodeURIComponent(this.opts.surface)}`;
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => {
      this.opts.onStateChange("connected");
    });

    this.socket.addEventListener("message", (event) => {
      let parsed: SpeakMessage | TranscriptMessage | TurnEndMessage | SurfaceStatusMessage;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn("[luna] ignoring malformed message from orchestrator");
        return;
      }
      if (parsed.type === "speak") {
        this.opts.onStateChange("connected");
        this.opts.onSpeak(parsed);
      } else if (parsed.type === "transcript") {
        this.opts.onTranscript(parsed);
      } else if (parsed.type === "turn_end") {
        this.opts.onTurnEnd(parsed.emotion);
      } else if (parsed.type === "surface_status") {
        this.opts.onSurfaceStatus?.(parsed.role);
      }
    });

    this.socket.addEventListener("close", () => {
      this.opts.onStateChange("offline");
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }

  sendUserText(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      console.warn("[luna] not connected to orchestrator yet");
      return;
    }
    this.opts.onStateChange("listening");
    this.socket.send(JSON.stringify({ type: "user_text", text }));
  }

  sendUserAudio(audioB64: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      console.warn("[luna] not connected to orchestrator yet");
      return;
    }
    this.opts.onStateChange("listening");
    this.socket.send(JSON.stringify({ type: "user_audio", audio_b64: audioB64 }));
  }

  /** Tells the orchestrator to cancel whatever's currently generating (if
   * anything -- a no-op on its side if nothing is). Client-side audio
   * playback is stopped separately and immediately by main.ts's
   * SpeakQueue.stopAll(), since waiting on a round-trip to the
   * orchestrator and back would make the stop button feel laggy for the
   * part that actually matters visually/audibly. */
  sendStop(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "stop" }));
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
