// Captures short voice clips from the user's mic via the browser's
// MediaRecorder API and hands each finished clip back as a Blob, ready to
// base64-encode and send to the orchestrator as a `user_audio` message
// (see ws-client.ts). No Tauri-specific mic plugin needed -- WebView2 (the
// webview Tauri uses on Windows) supports getUserMedia()/MediaRecorder like
// any Chromium-based browser, so this is plain Web APIs throughout, same
// spirit as lipsync.ts using plain Web Audio instead of a Tauri audio API.

// Toggle-to-record, not push-to-talk: this is a small, draggable,
// always-on-top overlay window, not a full-screen app -- a press-and-hold
// gesture is easy to lose (releasing the mouse button off-window loses the
// mouseup event entirely) which would leave the mic stuck recording with no
// way to stop it from the UI. Click once to start, click again to stop is
// robust regardless of where the mouse ends up.
const MAX_RECORDING_MS = 30_000; // safety net if the user forgets to click stop

// Chromium (WebView2's engine) supports opus-in-webm; fall back gracefully
// in case a future webview swap changes that. The orchestrator doesn't need
// to be told which of these it got -- faster-whisper decodes via PyAV,
// which sniffs the container/codec from the bytes themselves.
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ""; // let the browser pick its own default
}

export interface MicInputOptions {
  onRecordingChange: (recording: boolean) => void;
  onClip: (blob: Blob) => void;
  onError: (err: unknown) => void;
}

export class MicInput {
  private opts: MicInputOptions;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private activeMimeType = "";
  private maxDurationTimer: number | undefined;

  constructor(opts: MicInputOptions) {
    this.opts = opts;
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Starts recording if idle, stops (and flushes the clip) if recording. */
  async toggle(): Promise<void> {
    if (this.isRecording) {
      this.stopInternal();
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Most likely mic permission denied, or no input device present --
      // nothing to recover from here; the user can grant permission (or
      // plug in a mic) and click again.
      this.opts.onError(err);
      return;
    }

    this.activeMimeType = pickMimeType();
    this.recorder = this.activeMimeType
      ? new MediaRecorder(this.stream, { mimeType: this.activeMimeType })
      : new MediaRecorder(this.stream);
    this.chunks = [];

    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    // Both the manual toggle()-driven stop and the max-duration safety net
    // below go through recorder.stop() -> this "stop" event, not a direct
    // call -- MediaRecorder can still have a last "dataavailable" pending
    // right up to that event, so reading this.chunks any earlier could miss
    // the tail of the clip.
    this.recorder.addEventListener("stop", () => this.handleStopped());

    this.recorder.start();
    this.opts.onRecordingChange(true);
    this.maxDurationTimer = window.setTimeout(() => this.stopInternal(), MAX_RECORDING_MS);
  }

  private stopInternal(): void {
    window.clearTimeout(this.maxDurationTimer);
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
  }

  private handleStopped(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.opts.onRecordingChange(false);

    if (this.chunks.length) {
      const blob = new Blob(this.chunks, { type: this.activeMimeType || "audio/webm" });
      this.chunks = [];
      this.opts.onClip(blob);
    }
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
