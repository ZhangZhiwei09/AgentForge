// Voice Service — HTTP wrappers for voice API endpoints
import type {
  TranscribeResponse,
  SynthesizeRequest,
  SynthesizeResponse,
  VoiceProfile,
} from "@agentforge/shared-types";

export class VoiceService {
  constructor(
    private baseUrl: string,
    private getAccessToken: () => string | null,
  ) {}

  /** Get WebSocket URL for voice streaming */
  getWebSocketUrl(conversationId: string): string {
    const token = this.getAccessToken();
    const httpBase = this.baseUrl.replace(/^http/, "ws");
    return `${httpBase}/api/voice/stream?token=${encodeURIComponent(token ?? "")}&conversation_id=${encodeURIComponent(conversationId)}`;
  }

  /** One-shot: transcribe an audio file to text */
  async transcribe(audioFile: File): Promise<TranscribeResponse> {
    const formData = new FormData();
    formData.append("file", audioFile);

    const res = await fetch(`${this.baseUrl}/api/voice/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getAccessToken()}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(
        (err as { detail?: string }).detail || "Transcription failed",
      );
    }

    return res.json();
  }

  /** One-shot: synthesize text to audio */
  async synthesize(request: SynthesizeRequest): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/voice/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.getAccessToken()}`,
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(
        (err as { detail?: string }).detail || "Synthesis failed",
      );
    }

    return res.arrayBuffer();
  }

  /** List available TTS voices */
  async listVoices(): Promise<VoiceProfile[]> {
    const res = await fetch(`${this.baseUrl}/api/voice/voices`, {
      headers: {
        Authorization: `Bearer ${this.getAccessToken()}`,
      },
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as { voices: VoiceProfile[] };
    return data.voices;
  }
}
