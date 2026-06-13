import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppProjectStore } from "@/stores/app-project";
import type { AppProjectDTO, AppFilePlan, AppGenStreamEvent } from "@agentforge/shared-types";

interface AppGenChatProps {
  projectId: string;
}

export function AppGenChat({ projectId }: AppGenChatProps) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [chatMessages, setChatMessages] = useState<
    Array<{ role: string; content: string }>
  >([]);

  const {
    isGenerating,
    setIsGenerating,
    setGenStatus,
    setGenRunId,
    setGenPlan,
    clearGenErrors,
    addFile,
    setPreviewHtml,
  } = useAppProjectStore();

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;

    const userMessage = prompt.trim();
    setPrompt("");
    setChatMessages((prev) => [
      ...prev,
      { role: "user", content: userMessage },
      { role: "assistant", content: "Generating..." },
    ]);

    setIsGenerating(true);
    setGenStatus("planning");
    clearGenErrors();

    const token = localStorage.getItem("accessToken");

    try {
      const response = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: userMessage, skills: [] }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const event: AppGenStreamEvent = JSON.parse(data);
            assistantContent = handleStreamEvent(
              event,
              assistantContent,
              setChatMessages,
              setAssistContent,
            );
          } catch {
            // Skip malformed JSON
          }
        }
      }

      setIsGenerating(false);
      setGenStatus("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setChatMessages((prev) =>
        prev.slice(0, -1).concat({
          role: "assistant",
          content: `Error: ${msg}`,
        }),
      );
      setIsGenerating(false);
      setGenStatus("error");
    }
  };

  return (
    <div className="flex flex-col h-full border-t border-gray-200 bg-white">
      {/* Chat messages area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {chatMessages.length === 0 && (
          <div className="text-center text-gray-400 mt-8">
            <div className="text-4xl mb-3">🦊</div>
            <div className="text-sm font-medium mb-1">Describe your app idea</div>
            <div className="text-xs">
              AI will generate the complete code for you
            </div>
          </div>
        )}
        {chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`p-2 rounded-lg text-sm ${
              msg.role === "user"
                ? "bg-blue-50 ml-4"
                : "bg-gray-50 mr-4"
            }`}
          >
            <div className="text-xs font-medium text-gray-500 mb-1">
              {msg.role === "user" ? "You" : "CodeGen AI"}
            </div>
            <div className="whitespace-pre-wrap text-gray-800">{msg.content}</div>
          </div>
        ))}
        {isGenerating && (
          <div className="flex items-center gap-2 text-sm text-blue-600 p-2">
            <div className="animate-spin w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full" />
            <span>
              {useAppProjectStore.getState().genStatus === "planning"
                ? "Planning app structure..."
                : useAppProjectStore.getState().genStatus === "generating"
                  ? "Generating files..."
                  : "Processing..."}
            </span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="p-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleGenerate();
              }
            }}
            placeholder="Describe changes or new feature..."
            disabled={isGenerating}
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper extracted to avoid inline function definitions in the loop
function setAssistContent(
  content: string,
  setChatMessages: React.Dispatch<
    React.SetStateAction<Array<{ role: string; content: string }>>
  >,
  current: string,
): string {
  const updated = current + content;
  setChatMessages((prev) => {
    const copy = [...prev];
    const lastIdx = copy.length - 1;
    if (lastIdx >= 0 && copy[lastIdx].role === "assistant") {
      copy[lastIdx] = { ...copy[lastIdx], content: updated };
    }
    return copy;
  });
  return updated;
}

// Helper function to handle stream events
function handleStreamEvent(
  event: AppGenStreamEvent,
  assistantContent: string,
  setChatMessages: React.Dispatch<
    React.SetStateAction<Array<{ role: string; content: string }>>
  >,
  setAssistContentFn: typeof setAssistContent,
): string {
  const { setGenStatus, addFile, addGenTokens, setGenRunId, setGenPlan } =
    useAppProjectStore.getState();

  switch (event.type) {
    case "appgen_meta": {
      if (event.run_id) setGenRunId(event.run_id);
      const meta = `🚀 Generating **${event.name}**\nFramework: ${event.framework}`;
      return setAssistContentFn(meta, setChatMessages, assistantContent);
    }

    case "appgen_plan": {
      setGenStatus("generating");
      if (event.plan) setGenPlan(event.plan as AppFilePlan[]);
      const planFiles =
        event.plan && event.plan.length > 0
          ? (event.plan as AppFilePlan[])
              .map((f: AppFilePlan) => `• ${f.path} — ${f.description}`)
              .join("\n")
          : "Ready to generate files...";
      const planMsg = `📋 **App Structure:**\n${planFiles}`;
      setChatMessages((prev) => {
        const copy = [...prev];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === "assistant") {
          copy[lastIdx] = {
            ...copy[lastIdx],
            content: (copy[lastIdx].content || "") + "\n" + planMsg,
          };
        }
        return copy;
      });
      return "";
    }

    case "appgen_file_start": {
      const fileMsg = `\n⏳ Generating ${event.file_path}...`;
      return setAssistContentFn(fileMsg, setChatMessages, assistantContent);
    }

    case "appgen_file_done": {
      if (event.file_path && event.content) {
        addFile({
          id: crypto.randomUUID(),
          projectId: event.project_id || "",
          path: event.file_path,
          content: event.content,
          language: (event.language as any) || "tsx",
          size: event.size || 0,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        if (event.size) addGenTokens(event.size);
      }
      const doneMsg = `\n✅ Generated ${event.file_path} (${event.size || "?"} bytes)`;
      return setAssistContentFn(doneMsg, setChatMessages, assistantContent);
    }

    case "appgen_review": {
      setGenStatus("reviewing");
      const review = event.review || "Review complete.";
      return setAssistContentFn(
        `\n🔍 ${review}`,
        setChatMessages,
        assistantContent,
      );
    }

    case "appgen_done": {
      setGenStatus("done");
      const filesCount = event.result?.files_created?.length || 0;
      const tokens = event.result?.tokens_used || 0;
      const doneMsg = `\n\n✨ **Done!** Generated ${filesCount} files (${tokens} tokens)`;
      return setAssistContentFn(doneMsg, setChatMessages, assistantContent);
    }

    case "appgen_error": {
      setGenStatus("error");
      const errMsg = `\n❌ Error: ${event.error || "Unknown error"}`;
      return setAssistContentFn(errMsg, setChatMessages, assistantContent);
    }

    default:
      return assistantContent;
  }
}
