// Talks to the Python orchestrator (orchestrator/app.py) over a small JSON
// protocol. Phase 1 only needed two message shapes; Phase 2.5 adds voice
// input (user_audio / transcript):
//
//   -> { type: "user_text", text: string }
//   -> { type: "user_audio", audio_b64: string }
//   <- { type: "speak", text: string, audio_b64: string, mime: string, emotion?: string }
//   <- { type: "transcript", text: string }
//
// `emotion` is carried through already (Phase 6 will use it to pick a Live2D
// expression) but Phase 1's orchestrator doesn't set it to anything yet.
// `transcript` is sent once per `user_audio` message, always -- an empty
// `text` means the orchestrator heard nothing intelligible (silence, noise),
// which is distinct from a connection problem.

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

export type ConnectionState = "offline" | "connected" | "listening";

interface WsClientOptions {
  onSpeak: (msg: SpeakMessage) => void;
  onTranscript: (msg: TranscriptMessage) => void;
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
      let parsed: SpeakMessage | TranscriptMessage;
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

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
