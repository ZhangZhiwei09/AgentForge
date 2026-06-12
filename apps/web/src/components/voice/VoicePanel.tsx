// Voice Panel — real-time voice interaction UI
// Microphone → VAD → WebSocket → ASR → LLM → TTS → Audio Playback
import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, MicOff, Square, Volume2 } from "lucide-react";
import { useChatStore, type VoiceStatus } from "../../stores/chat";

// WebSocket URL builder
function getWsUrl(conversationId: string): string {
  const token = localStorage.getItem("accessToken") || "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/api/voice/stream?token=${encodeURIComponent(token)}&conversation_id=${encodeURIComponent(conversationId)}`;
}

// Map status to display text
const STATUS_LABELS: Record<VoiceStatus, string> = {
  idle: "Ready",
  listening: "Listening...",
  processing: "Processing...",
  speaking: "Speaking...",
};

const STATUS_COLORS: Record<VoiceStatus, string> = {
  idle: "text-gray-400",
  listening: "text-red-400",
  processing: "text-yellow-400",
  speaking: "text-green-400",
};

const VOICES = [
  { id: "alloy", name: "Alloy" },
  { id: "echo", name: "Echo" },
  { id: "fable", name: "Fable" },
  { id: "nova", name: "Nova" },
  { id: "onyx", name: "Onyx" },
  { id: "shimmer", name: "Shimmer" },
];

export function VoicePanel() {
  const conversationId = useChatStore((s) => s.currentConversationId);
  const voiceStatus = useChatStore((s) => s.voiceStatus);
  const voiceTranscript = useChatStore((s) => s.voiceTranscript);
  const setVoiceStatus = useChatStore((s) => s.setVoiceStatus);
  const appendVoiceTranscript = useChatStore((s) => s.appendVoiceTranscript);
  const clearVoiceTranscript = useChatStore((s) => s.clearVoiceTranscript);

  const [isMicActive, setIsMicActive] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState("alloy");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [voiceTranscript]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const startMic = useCallback(async () => {
    if (!conversationId) {
      setError("Select a conversation first");
      return;
    }

    setError(null);

    try {
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      });
      streamRef.current = stream;

      // Create AudioContext for playback and analysis
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // Connect WebSocket
      const ws = new WebSocket(getWsUrl(conversationId));
      wsRef.current = ws;

      ws.onopen = () => {
        setIsMicActive(true);
        setVoiceStatus("listening");
        clearVoiceTranscript();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setIsMicActive(false);
        setVoiceStatus("idle");
        stopStream();
      };

      ws.onerror = () => {
        setError("WebSocket connection failed");
        setIsMicActive(false);
        setVoiceStatus("idle");
        stopStream();
      };

      // Start recording: send audio chunks periodically
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioCtx.destination);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (processor as any).onaudioprocess = (e: AudioProcessingEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32Array to base64 PCM
        const pcmBuffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmBuffer[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }

        const base64 = arrayBufferToBase64(pcmBuffer.buffer as ArrayBuffer);
        ws.send(JSON.stringify({ type: "audio", data: base64 }));
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Mic access denied";
      setError(msg);
    }
  }, [conversationId, setVoiceStatus, clearVoiceTranscript]);

  const stopMic = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "speech_end" }));
    }
    setVoiceStatus("processing");
    stopStream();
  }, [setVoiceStatus]);

  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    setVoiceStatus("listening");
  }, [setVoiceStatus]);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleServerMessage = (msg: any) => {
    switch (msg.type) {
      case "status":
        setVoiceStatus(msg.status as VoiceStatus);
        break;
      case "transcript":
        appendVoiceTranscript({ role: "user", content: msg.text });
        break;
      case "response_text":
        // Accumulate in transcript
        break;
      case "audio": {
        // Play TTS audio (base64 MP3)
        const audioData = base64ToArrayBuffer(msg.data);
        if (audioCtxRef.current && audioData) {
          audioCtxRef.current.decodeAudioData(audioData, (buffer) => {
            const source = audioCtxRef.current!.createBufferSource();
            source.buffer = buffer;
            source.connect(audioCtxRef.current!.destination);
            source.start(0);
          });
        }
        break;
      }
      case "done":
        appendVoiceTranscript({ role: "assistant", content: "[Voice response complete]" });
        setVoiceStatus("idle");
        break;
      case "interrupted":
        setVoiceStatus("listening");
        break;
      case "error":
        setError(msg.message);
        setVoiceStatus("idle");
        break;
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="p-3 border-b border-gray-700">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Volume2 className="w-4 h-4" />
          Voice Chat
        </h3>
      </div>

      {/* Controls */}
      <div className="p-3 border-b border-gray-700 space-y-2">
        {/* Status */}
        <div className={`text-xs font-medium ${STATUS_COLORS[voiceStatus]}`}>
          {STATUS_LABELS[voiceStatus]}
        </div>

        {/* Error */}
        {error && (
          <div className="text-xs text-red-400 bg-red-900/30 p-2 rounded">
            {error}
            <button
              className="ml-2 underline"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Mic & Interrupt buttons */}
        <div className="flex gap-2">
          {!isMicActive ? (
            <button
              onClick={startMic}
              disabled={!conversationId}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs"
            >
              <Mic className="w-3.5 h-3.5" />
              Start Mic
            </button>
          ) : (
            <button
              onClick={stopMic}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded text-xs"
            >
              <MicOff className="w-3.5 h-3.5" />
              Stop
            </button>
          )}

          {voiceStatus === "speaking" && (
            <button
              onClick={interrupt}
              className="flex items-center gap-1 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 rounded text-xs"
            >
              <Square className="w-3.5 h-3.5" />
              Interrupt
            </button>
          )}
        </div>

        {/* Voice selector */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Voice:</label>
          <select
            value={selectedVoice}
            onChange={(e) => setSelectedVoice(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
        {voiceTranscript.length === 0 && (
          <div className="text-gray-500 text-center mt-4">
            Click the microphone to start speaking
          </div>
        )}
        {voiceTranscript.map((entry, i) => (
          <div
            key={i}
            className={`p-2 rounded ${
              entry.role === "user"
                ? "bg-blue-900/30 text-blue-200"
                : "bg-gray-800 text-gray-200"
            }`}
          >
            <span className="font-semibold text-gray-400">
              {entry.role === "user" ? "You" : "AI"}:
            </span>{" "}
            {entry.content}
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>
    </div>
  );
}

// ---- Helpers ----

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}
