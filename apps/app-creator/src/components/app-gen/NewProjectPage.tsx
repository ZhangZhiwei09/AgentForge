import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppProjectStore } from "@/stores/app-project";
import type {
  AppProjectDTO,
  AppFilePlan,
  AppGenStreamEvent,
} from "@agentforge/shared-types";

export function NewProjectPage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [framework, setFramework] = useState<string>("react");
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState<AppFilePlan[]>([]);
  const [generatedFiles, setGeneratedFiles] = useState<string[]>([]);
  const [error, setError] = useState("");

  const { setCurrentProject, addFile } = useAppProjectStore();

  const handleSubmit = async () => {
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setError("");
    setGeneratedFiles([]);
    setPlan([]);
    setStatus("Creating project...");

    const token = localStorage.getItem("accessToken");

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
          name: name.trim() || undefined,
          framework,
          type: "frontend",
        }),
      });

      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ detail: "Unknown error" }));
        throw new Error(err.detail || `HTTP ${response.status}`);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let projectId = "";

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

            switch (event.type) {
              case "appgen_meta": {
                projectId = event.project_id || "";
                setCurrentProject(projectId);
                setStatus(
                  `Generating "${event.name}" with ${event.framework}...`,
                );
                break;
              }
              case "appgen_plan": {
                if (event.plan) {
                  setPlan(event.plan as AppFilePlan[]);
                  setStatus("Planning complete — generating files...");
                }
                break;
              }
              case "appgen_file_start": {
                setStatus(`Generating ${event.file_path}...`);
                break;
              }
              case "appgen_file_done": {
                if (event.file_path && event.content) {
                  setGeneratedFiles((prev) => [...prev, event.file_path!]);
                  // Add to the store for when we navigate
                  if (projectId) {
                    addFile({
                      id: crypto.randomUUID(),
                      projectId,
                      path: event.file_path,
                      content: event.content,
                      language: (event.language as any) || "tsx",
                      size: event.size || 0,
                      version: 1,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                  setStatus(`Generated ${event.file_path}`);
                }
                break;
              }
              case "appgen_done": {
                const fileCount = event.result?.files_created?.length || 0;
                setStatus(`Done! Generated ${fileCount} files.`);
                // Navigate to project page after a brief delay
                if (projectId) {
                  setTimeout(() => navigate(`/projects/${projectId}`), 1500);
                }
                break;
              }
              case "appgen_error": {
                setError(event.error || "Generation failed");
                setStatus("");
                break;
              }
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      <div className="w-full max-w-2xl p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🦊</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Create Your App with AI
          </h1>
          <p className="text-gray-500 text-sm">
            Describe what you want to build — AI will generate the complete code
          </p>
        </div>

        {/* Input form */}
        {!isGenerating && !error && generatedFiles.length === 0 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                What do you want to build?
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="e.g. Build a task management app with drag-and-drop, categories, and dark mode support"
                rows={4}
                className="w-full px-4 py-3 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                autoFocus
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Project Name (optional)
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Awesome App"
                  className="w-full px-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Framework
                </label>
                <select
                  value={framework}
                  onChange={(e) => setFramework(e.target.value)}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="react">React + TypeScript</option>
                  <option value="html">HTML/CSS/JS</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={!prompt.trim()}
              className="w-full py-3 px-6 text-sm font-medium bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              🚀 Generate App
            </button>

            <p className="text-xs text-gray-400 text-center">
              Press Ctrl+Enter to submit • Generation takes 30-60 seconds
            </p>
          </div>
        )}

        {/* Generation progress */}
        {isGenerating && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 justify-center">
              <div className="animate-spin w-6 h-6 border-3 border-blue-600 border-t-transparent rounded-full" />
              <span className="text-sm text-gray-700">{status}</span>
            </div>

            {/* Plan display */}
            {plan.length > 0 && (
              <div className="mt-4 p-4 bg-white border border-gray-200 rounded-xl">
                <div className="text-xs font-medium text-gray-500 mb-2">
                  Planned Structure ({plan.length} files):
                </div>
                <div className="space-y-1">
                  {plan.map((f) => (
                    <div
                      key={f.path}
                      className={`flex items-center gap-2 text-xs ${
                        generatedFiles.includes(f.path)
                          ? "text-green-600"
                          : "text-gray-600"
                      }`}
                    >
                      <span>
                        {generatedFiles.includes(f.path) ? "✅" : "📄"}
                      </span>
                      <span className="font-mono">{f.path}</span>
                      <span className="text-gray-400">— {f.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
            <div className="text-sm font-medium text-red-800 mb-1">
              Generation Failed
            </div>
            <div className="text-sm text-red-600">{error}</div>
            <button
              onClick={() => {
                setError("");
                setGeneratedFiles([]);
                setPlan([]);
              }}
              className="mt-3 text-sm text-red-700 hover:text-red-900 underline"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
