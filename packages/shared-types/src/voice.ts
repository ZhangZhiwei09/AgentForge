// Voice Agent types — WebSocket bidirectional protocol + HTTP endpoints
// V5 Voice Agent: ASR → LLM → TTS pipeline over WebSocket

// ---- WebSocket Messages (Client → Server) ----

export interface VoiceAudioInput {
  type: "audio";
  data: string; // base64-encoded PCM 16-bit 16kHz mono
}

export interface VoiceSpeechEnd {
  type: "speech_end";
}

export interface VoiceInterrupt {
  type: "interrupt";
}

export interface VoicePing {
  type: "ping";
}

export type VoiceClientMessage =
  | VoiceAudioInput
  | VoiceSpeechEnd
  | VoiceInterrupt
  | VoicePing;

// ---- WebSocket Messages (Server → Client) ----

export interface VoiceTranscript {
  type: "transcript";
  text: string;
  is_final: boolean;
}

export interface VoiceResponseText {
  type: "response_text";
  text: string;
  message_id: string;
}

export interface VoiceAudioOutput {
  type: "audio";
  data: string; // base64-encoded MP3
  sequence: number;
}

export interface VoiceInterruptedEvent {
  type: "interrupted";
}

export interface VoiceDoneEvent {
  type: "done";
  message_id: string;
  usage: {
    asr_tokens: number;
    tts_chars: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface VoiceErrorEvent {
  type: "error";
  message: string;
}

export interface VoiceStatusEvent {
  type: "status";
  status: "listening" | "processing" | "speaking" | "idle";
}

export type VoiceServerMessage =
  | VoiceTranscript
  | VoiceResponseText
  | VoiceAudioOutput
  | VoiceInterruptedEvent
  | VoiceDoneEvent
  | VoiceErrorEvent
  | VoiceStatusEvent;

// ---- HTTP Endpoint Types ----

export interface TranscribeResponse {
  text: string;
  language: string;
  duration_sec: number;
}

export interface SynthesizeRequest {
  text: string;
  voice?: string; // e.g. "alloy", "echo", "nova"
  speed?: number; // 0.25 - 4.0
}

export interface SynthesizeResponse {
  format: string;
  duration_sec: number;
  size_bytes: number;
}

export interface VoiceSessionSummary {
  id: string;
  conversation_id: string;
  status: string;
  audio_duration_sec: number;
  asr_token_count: number;
  tts_char_count: number;
  transcript: Array<{ role: string; content: string }>;
  voice: string;
  created_at: string;
}

// ---- Voice Profiles ----

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "neutral";
}
