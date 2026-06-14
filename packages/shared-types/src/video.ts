// Video Agent types — WebSocket bidirectional protocol for multimodal video conversation
// V11 Multimodal Video: Camera + Mic → WebSocket → ASR + Vision → Multimodal LLM → TTS

// ---- WebSocket Messages (Client → Server) ----

export interface VideoStartRequest {
  type: "start_video";
  config?: {
    width?: number;
    height?: number;
    fps?: number;
  };
}

export interface VideoFrameInput {
  type: "video_frame";
  data: string; // base64-encoded JPEG frame
  timestamp: number; // Unix ms
}

export interface VideoAudioInput {
  type: "audio";
  data: string; // base64-encoded PCM 16-bit 16kHz mono
}

export interface VideoSpeechEnd {
  type: "speech_end";
}

export interface VideoInterrupt {
  type: "interrupt";
}

export interface VideoStopRequest {
  type: "stop_video";
}

export interface VideoPing {
  type: "ping";
}

export type VideoClientMessage =
  | VideoStartRequest
  | VideoFrameInput
  | VideoAudioInput
  | VideoSpeechEnd
  | VideoInterrupt
  | VideoStopRequest
  | VideoPing;

// ---- WebSocket Messages (Server → Client) ----

export interface VideoStatusEvent {
  type: "status";
  status:
    | "connecting"
    | "connected"
    | "listening"
    | "processing"
    | "speaking"
    | "idle";
}

export interface VideoTranscriptEvent {
  type: "transcript";
  text: string;
  is_final: boolean;
}

export interface VideoVisionContextEvent {
  type: "vision_context";
  description: string; // What the AI sees in the video frame
}

export interface VideoResponseTextEvent {
  type: "response_text";
  text: string;
  message_id: string;
}

export interface VideoAudioOutputEvent {
  type: "audio";
  data: string; // base64-encoded MP3
  sequence: number;
}

export interface VideoInterruptedEvent {
  type: "interrupted";
}

export interface VideoDoneEvent {
  type: "done";
  message_id: string;
  usage: {
    asr_tokens: number;
    tts_chars: number;
    vision_frames: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface VideoErrorEvent {
  type: "error";
  message: string;
  code?: string;
}

export interface VideoToolCallEvent {
  type: "tool_call";
  tool_call: {
    id: string;
    name: string;
    arguments: string;
  };
}

export interface VideoToolResultEvent {
  type: "tool_result";
  tool_result: {
    tool_call_id: string;
    name: string;
    result: string;
  };
}

export type VideoServerMessage =
  | VideoStatusEvent
  | VideoTranscriptEvent
  | VideoVisionContextEvent
  | VideoResponseTextEvent
  | VideoAudioOutputEvent
  | VideoInterruptedEvent
  | VideoDoneEvent
  | VideoErrorEvent
  | VideoToolCallEvent
  | VideoToolResultEvent;

// ---- HTTP Endpoint Types ----

export interface CreateVideoSessionRequest {
  conversation_id: string;
  agent_config?: {
    system_prompt?: string; // Custom system prompt for the video agent
    enabled_tools?: string[]; // Tools the agent can use
    vision_enabled?: boolean; // Whether to send video frames to the LLM
    vision_interval_ms?: number; // Frame capture interval (default 3000)
  };
}

export interface VideoSessionResponse {
  id: string;
  conversation_id: string;
  status: string;
  created_at: string;
}

export interface VideoSessionSummary {
  id: string;
  conversation_id: string;
  status: string;
  video_duration_sec: number;
  audio_duration_sec: number;
  asr_token_count: number;
  tts_char_count: number;
  vision_frames_count: number;
  transcript: Array<{ role: string; content: string }>;
  created_at: string;
  ended_at: string | null;
}
