// Customer Video Call — self-contained multimodal video conversation for customer service
// Camera + Mic → WebSocket → ASR + Vision + KB → Multimodal LLM → TTS → Audio Playback
//
// Architecture:
//   1. getUserMedia (camera + mic) → <video> preview + AudioContext
//   2. Canvas captures video frames → base64 JPEG → WebSocket
//   3. ScriptProcessor captures audio PCM → base64 → WebSocket
//   4. WebSocket receives: transcript, vision_context, response_text, audio (MP3), done
//   5. AudioContext decodes and plays TTS MP3 chunks
//
// Key differences from VideoCallPanel:
//   - Self-contained: all state local (useState/useRef), no useChatStore dependency
//   - Anonymous: no auth token needed, uses session_id instead of conversation_id
//   - Auto-starts on mount, cleanup on unmount
import { useEffect, useRef, useState, useCallback } from "react";
import { Video, VideoOff, Mic, MicOff, PhoneOff, Eye, EyeOff, X } from "lucide-react";

// ---- Constants ----

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const FRAME_CAPTURE_INTERVAL_MS = 3000;
const AUDIO_CHUNK_SIZE = 4096;

type VideoStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "processing"
  | "speaking";

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

// ---- Props ----

interface CustomerVideoCallProps {
  sessionId: string;
  onClose: () => void;
}

// ---- WebSocket URL Builder ----

function getCustomerVideoWsUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/api/customer-chat/video/stream?session_id=${encodeURIComponent(sessionId)}&vision_enabled=true&vision_interval_ms=${FRAME_CAPTURE_INTERVAL_MS}`;
}

// ---- Component ----

export function CustomerVideoCall({ sessionId, onClose }: CustomerVideoCallProps) {
  const [status, setStatus] = useState<VideoStatus>("idle");
  const [isCallActive, setIsCallActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isVisionEnabled, setIsVisionEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Array<{ role: string; content: string }>>([]);
  const [visionContext, setVisionContext] = useState("");

  const [hasVideo, setHasVideo] = useState(true);

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
  }, [transcript]);

  // Auto-start on mount, cleanup on unmount
  useEffect(() => {
    startCall();
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
          setStatus("connected");
          setTranscript((prev) => [
            ...prev,
            {
              role: "system",
              content: `视频会话已建立 (ID: ${msg.session_id})`,
            },
          ]);
          break;

        case "status":
          setStatus(msg.status as VideoStatus);
          break;

        case "transcript":
          setTranscript((prev) => [...prev, { role: "user", content: msg.text }]);
          break;

        case "vision_context":
          setVisionContext(msg.description);
          break;

        case "response_text":
          // Accumulated in the transcript — handled via transcript state
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
          setTranscript((prev) => [
            ...prev,
            {
              role: "assistant",
              content: msg.usage
                ? `[回复完成 · 视觉帧数: ${msg.usage.vision_frames}]`
                : "[回复完成]",
            },
          ]);
          setStatus("connected");
          setVisionContext("");
          break;

        case "interrupted":
          setStatus("listening");
          setVisionContext("");
          break;

        case "error":
          setError(msg.message);
          break;
      }
    },
    [],
  );

  // ---- Start / Stop Call ----

  const startCall = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setVisionContext("");

    try {
      // Step 1: Try camera + mic, fall back to audio-only if camera unavailable
      let stream: MediaStream;
      let videoAvailable = true;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: VIDEO_WIDTH },
            height: { ideal: VIDEO_HEIGHT },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (firstErr: unknown) {
        const msg = (firstErr as Error)?.message || "";
        if (
          msg.includes("NotFound") ||
          msg.includes("device") ||
          msg.includes("video")
        ) {
          // Camera not available — try audio-only
          stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
            },
          });
          videoAvailable = false;
        } else {
          throw firstErr; // Re-throw permission errors etc.
        }
      }

      streamRef.current = stream;
      setHasVideo(videoAvailable);
      if (!videoAvailable) {
        setIsVideoOff(true);
        setIsVisionEnabled(false);
      }

      if (videoRef.current && videoAvailable) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;

      // Connect WebSocket
      setStatus("connecting");
      const ws = new WebSocket(getCustomerVideoWsUrl(sessionId));
      wsRef.current = ws;

      ws.onopen = () => {
        setIsCallActive(true);
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
        setStatus("idle");
        stopMedia();
      };

      ws.onerror = () => {
        setError("WebSocket 连接失败");
        setIsCallActive(false);
        setStatus("idle");
        stopMedia();
      };

      // Start audio capture
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
            pcmBuffer[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
          }
          const base64 = arrayBufferToBase64(pcmBuffer.buffer as ArrayBuffer);
          ws.send(JSON.stringify({ type: "audio", data: base64 }));
        }
      };

      // Start video frame capture (only if video is available)
      if (videoAvailable) {
        frameTimerRef.current = setInterval(() => {
          if (isVideoOff || !ws || ws.readyState !== WebSocket.OPEN || !isVisionEnabled) {
            return;
          }

          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || video.readyState < 2) return;

          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          canvas.width = video.videoWidth || VIDEO_WIDTH;
          canvas.height = video.videoHeight || VIDEO_HEIGHT;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          const jpegData = canvas.toDataURL("image/jpeg", 0.6);
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
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "";
      if (errMsg.includes("NotAllowed") || errMsg.includes("Permission")) {
        setError("摄像头/麦克风权限被拒绝，请在浏览器设置中允许访问");
      } else if (errMsg.includes("NotFound") || errMsg.includes("device")) {
        setError("未检测到音频输入设备，请连接麦克风后重试");
      } else if (errMsg.includes("NotReadable")) {
        setError("音频设备被其他应用占用，请关闭其他应用后重试");
      } else {
        setError(errMsg || "无法启动视频通话，请检查设备连接");
      }
      setStatus("idle");
    }
  }, [sessionId, isMuted, isVideoOff, isVisionEnabled, handleServerMessage]);

  const endCall = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop_video" }));
    }
    cleanup();
    setIsCallActive(false);
    setStatus("idle");
    onClose();
  }, [cleanup, onClose]);

  const stopMedia = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const sendSpeechEnd = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "speech_end" }));
      setStatus("processing");
    }
  }, []);

  const interruptAgent = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
      setStatus("listening");
    }
  }, []);

  const toggleMute = () => setIsMuted((prev) => !prev);
  const toggleVideo = () => setIsVideoOff((prev) => !prev);
  const toggleVision = () => setIsVisionEnabled((prev) => !prev);

  // ---- Render ----

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="p-2 sm:p-3 border-b border-gray-700 flex items-center justify-between shrink-0">
        <h3 className="text-xs sm:text-sm font-semibold flex items-center gap-2">
          <Video className="w-4 h-4" />
          视频客服
        </h3>
        <button
          onClick={endCall}
          className="p-2 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="关闭视频通话"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Status Bar */}
      <div className="p-2 border-b border-gray-700 flex items-center gap-2 shrink-0">
        <div
          className={`w-2 h-2 rounded-full shrink-0 ${
            isCallActive ? "bg-green-400 animate-pulse" : "bg-gray-500"
          }`}
        />
        <span className={`text-xs font-medium ${STATUS_COLORS[status]}`}>
          {STATUS_LABELS[status]}
        </span>
        {visionContext && (
          <span className="text-xs text-purple-400 ml-auto truncate max-w-[120px] sm:max-w-[180px]">
            <Eye className="w-3 h-3 inline mr-1" />
            {visionContext}
          </span>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-2 mx-2 mt-2 text-xs sm:text-sm text-red-400 bg-red-900/30 rounded flex items-center justify-between shrink-0">
          <span className="flex-1 mr-2">{error}</span>
          <button
            className="underline hover:text-red-300 shrink-0"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Video Area */}
      <div className="relative flex-shrink-0 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full ${isVideoOff ? "hidden" : ""}`}
          style={{ maxHeight: "min(280px, 35vh)", objectFit: "cover" }}
        />

        {isVideoOff && (
          <div className="w-full flex flex-col items-center justify-center bg-gray-800 gap-2 sm:gap-3 py-8 sm:py-10">
            <VideoOff className="w-10 h-10 sm:w-12 sm:h-12 text-gray-600" />
            <span className="text-xs sm:text-sm text-gray-500 text-center px-4">
              {hasVideo ? "摄像头已关闭" : "纯语音模式（未检测到摄像头）"}
            </span>
          </div>
        )}

        <canvas ref={canvasRef} className="hidden" />

        {status === "speaking" && (
          <div className="absolute bottom-2 right-2 bg-blue-600/80 rounded-lg px-3 py-1.5 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="flex gap-0.5">
                <span className="w-1 h-3 bg-white rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1 h-3 bg-white rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1 h-3 bg-white rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              AI 正在回复...
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
              className="flex items-center gap-2 px-5 py-3 sm:px-4 sm:py-2 bg-green-600 hover:bg-green-700 active:bg-green-800 rounded-lg text-sm font-medium transition-colors active:scale-95"
            >
              <Video className="w-5 h-5 sm:w-4 sm:h-4" />
              开始视频通话
            </button>
          ) : (
            <>
              <button
                onClick={toggleVision}
                className={`p-2.5 sm:p-2 rounded-lg transition-colors active:scale-95 ${
                  isVisionEnabled
                    ? "bg-purple-600 hover:bg-purple-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={isVisionEnabled ? "视觉: 开" : "视觉: 关"}
              >
                {isVisionEnabled ? <Eye className="w-5 h-5 sm:w-4 sm:h-4" /> : <EyeOff className="w-5 h-5 sm:w-4 sm:h-4" />}
              </button>

              <button
                onClick={toggleVideo}
                className={`p-2.5 sm:p-2 rounded-lg transition-colors active:scale-95 ${
                  !isVideoOff ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={isVideoOff ? "开启视频" : "关闭视频"}
              >
                {isVideoOff ? <VideoOff className="w-5 h-5 sm:w-4 sm:h-4" /> : <Video className="w-5 h-5 sm:w-4 sm:h-4" />}
              </button>

              <button
                onClick={toggleMute}
                className={`p-2.5 sm:p-2 rounded-lg transition-colors active:scale-95 ${
                  !isMuted ? "bg-blue-600 hover:bg-blue-700" : "bg-red-600 hover:bg-red-700"
                }`}
                title={isMuted ? "取消静音" : "静音"}
              >
                {isMuted ? <MicOff className="w-5 h-5 sm:w-4 sm:h-4" /> : <Mic className="w-5 h-5 sm:w-4 sm:h-4" />}
              </button>

              {status !== "speaking" ? (
                <button
                  onClick={sendSpeechEnd}
                  className="p-2.5 sm:p-2 rounded-lg bg-yellow-600 hover:bg-yellow-700 transition-colors active:scale-95"
                  title="说完"
                >
                  <Mic className="w-5 h-5 sm:w-4 sm:h-4" />
                </button>
              ) : (
                <button
                  onClick={interruptAgent}
                  className="p-2.5 sm:p-2 rounded-lg bg-orange-600 hover:bg-orange-700 transition-colors active:scale-95"
                  title="打断"
                >
                  <MicOff className="w-5 h-5 sm:w-4 sm:h-4" />
                </button>
              )}

              <button
                onClick={endCall}
                className="p-2.5 sm:p-2 rounded-lg bg-red-600 hover:bg-red-700 transition-colors active:scale-95"
                title="挂断"
              >
                <PhoneOff className="w-5 h-5 sm:w-4 sm:h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
        {transcript.length === 0 && (
          <div className="text-gray-500 text-center mt-4">
            摄像头和麦克风已激活 — 开始说话...
          </div>
        )}
        {transcript.map((entry, i) => (
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
              {entry.role === "user" ? "你" : entry.role === "system" ? "系统" : "AI 客服"}
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
          AI 可以看见您的视频画面 · 每 {FRAME_CAPTURE_INTERVAL_MS / 1000}s 捕捉一帧
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
