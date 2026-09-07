// Talks to the Python orchestrator (orchestrator/app.py) over a small JSON
// protocol. Phase 1 only needed two message shapes; Phase 2.5 adds voice
// input (user_audio / transcript); this round adds a "stop" button:
//
//   -> { type: "user_text", text: string }
//   -> { type: "user_audio", audio_b64: string }
//   -> { type: "stop" }
//   <- { type: "speak", text: string, audio_b64: string, mime: string, emotion?: string }
//   <- { type: "transcript", text: string }
//   <- { type: "turn_end" }
//
// `emotion` is carried through already (Phase 6 will use it to pick a Live2D
// expression) but Phase 1's orchestrator doesn't set it to anything yet.
// `transcript` is sent once per `user_audio` message, always -- an empty
// `text` means the orchestrator heard nothing intelligible (silence, noise),
// which is distinct from a connection problem. `turn_end` is sent once a
// reply is fully done generating, whether it finished normally or was cut
// short by a `stop` -- the frontend uses it to know when to re-enable input
// and hide the stop button, since queued audio finishing playback isn't the
// same signal (more chunks could still be on the way when audio catches up).

const ORCHESTRATOR_URL = "ws://127.0.0.1:8765/ws";
const RECONNECT_DELAY_MS = 2000;

export type SpeakMessage = {
  type: "speak";
  text: string;
  audio_b64: string;
  mime: string;
  emotion?: string;
};

export type TranscriptMessage = {
  type: "transcript";
  text: string;
};

export type TurnEndMessage = {
  type: "turn_end";
};

export type ConnectionState = "offline" | "connected" | "listening";

interface WsClientOptions {
  onSpeak: (msg: SpeakMessage) => void;
  onTranscript: (msg: TranscriptMessage) => void;
  onTurnEnd: () => void;
  onStateChange: (state: ConnectionState) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private opts: WsClientOptions;
  private reconnectTimer: number | undefined;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    this.socket = new WebSocket(ORCHESTRATOR_URL);

    this.socket.addEventListener("open", () => {
      this.opts.onStateChange("connected");
    });

    this.socket.addEventListener("message", (event) => {
      let parsed: SpeakMessage | TranscriptMessage | TurnEndMessage;
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
        this.opts.onTurnEnd();
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
