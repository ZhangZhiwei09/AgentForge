// Video Call Panel — real-time multimodal video conversation UI
// Camera + Mic → WebSocket → ASR + Vision → Multimodal LLM → TTS → Audio Playback
//
// Architecture:
//   1. getUserMedia (camera + mic) → <video> preview + AudioContext
//   2. Canvas captures video frames → base64 JPEG → WebSocket
//   3. ScriptProcessor captures audio PCM → base64 → WebSocket
//   4. WebSocket receives: transcript, vision_context, response_text, audio (MP3), done
//   5. AudioContext decodes and plays TTS MP3 chunks
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  PhoneOff,
  Eye,
  EyeOff,
} from "lucide-react";
import { useChatStore, type VideoStatus } from "../../stores/chat";

// ---- Constants ----

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const FRAME_CAPTURE_INTERVAL_MS = 3000; // Capture 1 frame every 3 seconds
const AUDIO_CHUNK_SIZE = 4096;

const STATUS_LABELS: Record<VideoStatus, string> = {
  idle: "Ready",
  connecting: "Connecting...",
  connected: "Connected",
  listening: "Listening...",
  processing: "Processing...",
  speaking: "Speaking...",
};

const STATUS_COLORS: Record<VideoStatus, string> = {
  idle: "text-gray-400",
  connecting: "text-yellow-400",
  connected: "text-green-400",
  listening: "text-red-400",
  processing: "text-yellow-400",
  speaking: "text-blue-400",
};

// ---- WebSocket URL Builder ----

function getVideoWsUrl(conversationId: string): string {
  const token = localStorage.getItem("accessToken") || "";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/api/video/stream?token=${encodeURIComponent(token)}&conversation_id=${encodeURIComponent(conversationId)}&vision_enabled=true&vision_interval_ms=${FRAME_CAPTURE_INTERVAL_MS}`;
}

// ---- Component ----

export function VideoCallPanel() {
  const conversationId = useChatStore((s) => s.currentConversationId);
  const videoStatus = useChatStore((s) => s.videoStatus);
  const videoTranscript = useChatStore((s) => s.videoTranscript);
  const videoVisionContext = useChatStore((s) => s.videoVisionContext);
  const setVideoStatus = useChatStore((s) => s.setVideoStatus);
  const setVideoActive = useChatStore((s) => s.setVideoActive);
  const appendVideoTranscript = useChatStore((s) => s.appendVideoTranscript);
  const clearVideoTranscript = useChatStore((s) => s.clearVideoTranscript);
  const setVideoVisionContext = useChatStore((s) => s.setVideoVisionContext);

  const [isCallActive, setIsCallActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isVisionEnabled, setIsVisionEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [videoTranscript]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
  }, []);

  // ---- WebSocket Message Handler ----

  const handleServerMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any) => {
      switch (msg.type) {
        case "session":
          setVideoStatus("connected");
          appendVideoTranscript({
            role: "system",
            content: `Video session started (ID: ${msg.session_id})`,
          });
          break;

        case "status":
          setVideoStatus(msg.status as VideoStatus);
          break;

        case "transcript":
          appendVideoTranscript({ role: "user", content: msg.text });
          break;

        case "vision_context":
          setVideoVisionContext(msg.description);
          break;

        case "response_text":
          // Accumulated in the transcript
          break;

        case "audio": {
          // Play TTS audio (base64 MP3)
          const audioData = base64ToArrayBuffer(msg.data);
          if (audioCtxRef.current && audioData) {
            audioCtxRef.current
              .decodeAudioData(audioData, (buffer) => {
                const source = audioCtxRef.current!.createBufferSource();
                source.buffer = buffer;
                source.connect(audioCtxRef.current!.destination);
                source.start(0);
              })
              .catch(() => {
                // Audio decode failed — non-critical
              });
          }
          break;
        }

        case "done":
          appendVideoTranscript({
            role: "assistant",
            content: msg.usage
              ? `[Response complete · Vision frames: ${msg.usage.vision_frames}]`
              : "[Response complete]",
          });
          setVideoStatus("connected");
          setVideoVisionContext("");
          break;

        case "interrupted":
          setVideoStatus("listening");
          setVideoVisionContext("");
          break;

        case "error":
          setError(msg.message);
          break;
      }
    },
    [setVideoStatus, appendVideoTranscript, setVideoVisionContext],
  );

  // ---- Start / Stop Call ----

  const startCall = useCallback(async () => {
    if (!conversationId) {
      setError("Select a conversation first");
      return;
    }

    setError(null);
    clearVideoTranscript();
    setVideoVisionContext("");

    try {
      // Get camera + mic
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: VIDEO_WIDTH },
          height: { ideal: VIDEO_HEIGHT },
          facingMode: "user",
        },
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Set up video preview
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }

      // Create AudioContext
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // Connect WebSocket
      setVideoStatus("connecting");
      const ws = new WebSocket(getVideoWsUrl(conversationId));
      wsRef.current = ws;

      ws.onopen = () => {
        setIsCallActive(true);
        setVideoActive(true);
        // Send start_video
        ws.send(
          JSON.stringify({
            type: "start_video",
            config: {
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT,
              fps: Math.round(1000 / FRAME_CAPTURE_INTERVAL_MS),
            },
          }),
        );
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
        setIsCallActive(false);
        setVideoActive(false);
        setVideoStatus("idle");
        stopMedia();
      };

      ws.onerror = () => {
        setError("WebSocket connection failed");
        setIsCallActive(false);
        setVideoActive(false);
        setVideoStatus("idle");
        stopMedia();
      };

      // Start audio capture (same pattern as VoicePanel)
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(AUDIO_CHUNK_SIZE, 1, 1);
      source.connect(processor);
      processor.connect(audioCtx.destination);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (processor as any).onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isMuted && ws.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmBuffer = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcmBuffer[i] = Math.max(
              -32768,
              Math.min(32767, inputData[i] * 32768),
            );
          }
          const base64 = arrayBufferToBase64(pcmBuffer.buffer as ArrayBuffer);
          ws.send(JSON.stringify({ type: "audio", data: base64 }));
        }
      };

      // Start video frame capture (~1 fps)
      frameTimerRef.current = setInterval(() => {
        if (
          isVideoOff ||
          !ws ||
          ws.readyState !== WebSocket.OPEN ||
          !isVisionEnabled
        ) {
          return;
        }

        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState < 2) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Draw current video frame to canvas
        canvas.width = video.videoWidth || VIDEO_WIDTH;
        canvas.height = video.videoHeight || VIDEO_HEIGHT;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert to base64 JPEG (quality 0.6 for bandwidth efficiency)
        const jpegData = canvas.toDataURL("image/jpeg", 0.6);
        // Strip the data:image/jpeg;base64, prefix
        const base64 = jpegData.split(",")[1];

        if (base64 && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "video_frame",
              data: base64,
              timestamp: Date.now(),
            }),
          );
        }
      }, FRAME_CAPTURE_INTERVAL_MS);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Camera/mic access denied";
      setError(msg);
    }
  }, [
    conversationId,
    isMuted,
    isVideoOff,
    isVisionEnabled,
    setVideoStatus,
    setVideoActive,
    clearVideoTranscript,
    setVideoVisionContext,
    handleServerMessage,
  ]);

  const endCall = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop_video" }));
    }
    cleanup();
    setIsCallActive(false);
    setVideoActive(false);
    setVideoStatus("idle");
  }, [cleanup, setVideoActive, setVideoStatus]);

  const stopMedia = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const sendSpeechEnd = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "speech_end" }));
      setVideoStatus("processing");
    }
  }, [setVideoStatus]);

  const interruptAgent = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
      setVideoStatus("listening");
    }
  }, [setVideoStatus]);

  const toggleMute = () => setIsMuted((prev) => !prev);
  const toggleVideo = () => setIsVideoOff((prev) => !prev);
  const toggleVision = () => setIsVisionEnabled((prev) => !prev);

  // ---- Render ----

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="p-3 border-b border-gray-700">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Video className="w-4 h-4" />
          Video Chat
        </h3>
      </div>

      {/* Status Bar */}
      <div className="p-2 border-b border-gray-700 flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full ${
            isCallActive ? "bg-green-400 animate-pulse" : "bg-gray-500"
          }`}
        />
        <span className={`text-xs font-medium ${STATUS_COLORS[videoStatus]}`}>
          {STATUS_LABELS[videoStatus]}
        </span>
        {videoVisionContext && (
          <span className="text-xs text-purple-400 ml-auto truncate max-w-[200px]">
            <Eye className="w-3 h-3 inline mr-1" />
            {videoVisionContext}
          </span>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-2 mx-2 mt-2 text-xs text-red-400 bg-red-900/30 rounded">
          {error}
          <button
            className="ml-2 underline hover:text-red-300"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Video Area */}
      <div className="relative flex-shrink-0 bg-black">
        {/* Main video (self-view) */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted // Prevent echo — we only capture via AudioContext
          className={`w-full ${isVideoOff ? "hidden" : ""}`}
          style={{ maxHeight: "280px", objectFit: "cover" }}
        />

        {/* Video off placeholder */}
        {isVideoOff && (
          <div className="w-full h-[200px] flex items-center justify-center bg-gray-800">
            <VideoOff className="w-12 h-12 text-gray-600" />
          </div>
        )}

        {/* Hidden canvas for frame capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* AI Avatar/Overlay (shown when agent is responding) */}
        {videoStatus === "speaking" && (
          <div className="absolute bottom-2 right-2 bg-blue-600/80 rounded-lg px-3 py-1.5 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="flex gap-0.5">
                <span
                  className="w-1 h-3 bg-white rounded-full animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1 h-3 bg-white rounded-full animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1 h-3 bg-white rounded-full animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
              AI Speaking...
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="p-3 border-b border-gray-700">
        <div className="flex items-center justify-center gap-3">
          {!isCallActive ? (
            <button
              onClick={startCall}
              disabled={!conversationId}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              <Video className="w-4 h-4" />
              Start Video Call
            </button>
          ) : (
            <>
              {/* Vision toggle */}
              <button
                onClick={toggleVision}
                className={`p-2 rounded-lg transition-colors ${
                  isVisionEnabled
                    ? "bg-purple-600 hover:bg-purple-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={isVisionEnabled ? "Vision: ON" : "Vision: OFF"}
              >
                {isVisionEnabled ? (
                  <Eye className="w-4 h-4" />
                ) : (
                  <EyeOff className="w-4 h-4" />
                )}
              </button>

              {/* Video toggle */}
              <button
                onClick={toggleVideo}
                className={`p-2 rounded-lg transition-colors ${
                  !isVideoOff
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={isVideoOff ? "Turn Video On" : "Turn Video Off"}
              >
                {isVideoOff ? (
                  <VideoOff className="w-4 h-4" />
                ) : (
                  <Video className="w-4 h-4" />
                )}
              </button>

              {/* Mute toggle */}
              <button
                onClick={toggleMute}
                className={`p-2 rounded-lg transition-colors ${
                  !isMuted
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-red-600 hover:bg-red-700"
                }`}
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>

              {/* Send / Interrupt button */}
              {videoStatus !== "speaking" ? (
                <button
                  onClick={sendSpeechEnd}
                  className="p-2 rounded-lg bg-yellow-600 hover:bg-yellow-700 transition-colors"
                  title="Finish Speaking"
                >
                  <Mic className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={interruptAgent}
                  className="p-2 rounded-lg bg-orange-600 hover:bg-orange-700 transition-colors"
                  title="Interrupt"
                >
                  <MicOff className="w-4 h-4" />
                </button>
              )}

              {/* End Call */}
              <button
                onClick={endCall}
                className="p-2 rounded-lg bg-red-600 hover:bg-red-700 transition-colors"
                title="End Call"
              >
                <PhoneOff className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
        {videoTranscript.length === 0 && !isCallActive && (
          <div className="text-gray-500 text-center mt-4">
            Start a video call to talk with the AI agent
          </div>
        )}
        {videoTranscript.length === 0 && isCallActive && (
          <div className="text-gray-500 text-center mt-4">
            Camera and microphone active — start speaking...
          </div>
        )}
        {videoTranscript.map((entry, i) => (
          <div
            key={i}
            className={`p-2 rounded ${
              entry.role === "user"
                ? "bg-blue-900/30 text-blue-200"
                : entry.role === "system"
                  ? "bg-gray-800 text-gray-400 italic"
                  : "bg-gray-800 text-gray-200"
            }`}
          >
            <span className="font-semibold text-gray-400">
              {entry.role === "user"
                ? "You"
                : entry.role === "system"
                  ? "System"
                  : "AI"}
              :
            </span>{" "}
            {entry.content}
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>

      {/* Vision indicator */}
      {isCallActive && isVisionEnabled && (
        <div className="p-2 border-t border-gray-700 text-xs text-gray-500 flex items-center gap-2">
          <Eye className="w-3 h-3 text-purple-400" />
          AI can see your video · Frame capture: every{" "}
          {FRAME_CAPTURE_INTERVAL_MS / 1000}s
        </div>
      )}
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
