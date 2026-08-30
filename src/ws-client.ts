// Talks to the Python orchestrator (orchestrator/app.py) over a small JSON
// protocol. Phase 1 only needs two message shapes:
//
//   -> { type: "user_text", text: string }
//   <- { type: "speak", text: string, audio_b64: string, mime: string, emotion?: string }
//
// `emotion` is carried through already (Phase 6 will use it to pick a Live2D
// expression) but Phase 1's orchestrator doesn't set it to anything yet.

const ORCHESTRATOR_URL = "ws://127.0.0.1:8765/ws";
const RECONNECT_DELAY_MS = 2000;

export type SpeakMessage = {
  type: "speak";
  text: string;
  audio_b64: string;
  mime: string;
  emotion?: string;
};

export type ConnectionState = "offline" | "connected" | "listening";

interface WsClientOptions {
  onSpeak: (msg: SpeakMessage) => void;
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
      let parsed: SpeakMessage;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        console.warn("[luna] ignoring malformed message from orchestrator");
        return;
      }
      if (parsed.type === "speak") {
        this.opts.onStateChange("connected");
        this.opts.onSpeak(parsed);
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

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
