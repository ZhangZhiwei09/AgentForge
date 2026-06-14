import { useAppProjectStore } from "@/stores/app-project";
import type { ProjectLanguage } from "@agentforge/shared-types";

// Simple language → language tag for <pre><code>
const languageTags: Record<string, string> = {
  tsx: "language-tsx",
  ts: "language-typescript",
  css: "language-css",
  html: "language-html",
  json: "language-json",
  js: "language-javascript",
};

export function CodeEditor() {
  const {
    files,
    activeFilePath,
    activeFileContent,
    editMode,
    setActiveFile,
    setActiveFileContent,
    setEditMode,
  } = useAppProjectStore();

  const activeFile = files.find((f) => f.path === activeFilePath);
  const language = activeFile?.language || "tsx";

  const handleSave = async () => {
    if (!activeFilePath) return;

    const token = localStorage.getItem("accessToken");
    const projectId = useAppProjectStore.getState().currentProjectId;
    if (!projectId) return;

    try {
      await fetch(
        `/api/projects/${projectId}/files/${encodeURIComponent(activeFilePath)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: activeFileContent,
            language,
          }),
        },
      );
      setEditMode(false);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* File tabs */}
      <div className="flex items-center border-b border-gray-200 bg-white overflow-x-auto">
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => setActiveFile(file.path)}
            className={`flex items-center gap-1 px-3 py-2 text-xs whitespace-nowrap border-r border-gray-200 transition-colors ${
              activeFilePath === file.path
                ? "bg-gray-50 text-blue-600 font-medium border-b-2 border-b-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <span className="text-gray-400">
              {getFileIcon(file.language as ProjectLanguage)}
            </span>
            <span>{file.path.split("/").pop()}</span>
          </button>
        ))}
        {/* Edit/Save toggle */}
        {activeFilePath && (
          <div className="ml-auto px-3 flex gap-2">
            {!editMode ? (
              <button
                onClick={() => setEditMode(true)}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                Edit
              </button>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  className="text-xs text-green-600 hover:text-green-800 font-medium"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditMode(false);
                    // Restore original content
                    const file = files.find((f) => f.path === activeFilePath);
                    if (file) setActiveFileContent(file.content);
                  }}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Code area */}
      <div className="flex-1 overflow-auto min-h-0">
        {!activeFilePath ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Select a file to view its code
          </div>
        ) : editMode ? (
          <textarea
            value={activeFileContent}
            onChange={(e) => setActiveFileContent(e.target.value)}
            className="w-full h-full p-4 font-mono text-sm bg-white text-gray-800 resize-none focus:outline-none"
            spellCheck={false}
          />
        ) : (
          <pre className="p-4 m-0 font-mono text-sm text-gray-800 overflow-auto">
            <code className={languageTags[language] || ""}>
              {activeFileContent}
            </code>
          </pre>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center px-3 py-1 text-xs text-gray-500 bg-white border-t border-gray-200">
        {activeFilePath && (
          <>
            <span>{activeFilePath}</span>
            <span className="mx-2">•</span>
            <span>{language.toUpperCase()}</span>
            <span className="mx-2">•</span>
            <span>{activeFileContent.length} chars</span>
          </>
        )}
      </div>
    </div>
  );
}

function getFileIcon(language: ProjectLanguage): string {
  switch (language) {
    case "tsx":
    case "ts":
      return "📘";
    case "css":
      return "🎨";
    case "html":
      return "🌐";
    case "json":
      return "📋";
    case "js":
      return "📒";
    default:
      return "📄";
  }
}
