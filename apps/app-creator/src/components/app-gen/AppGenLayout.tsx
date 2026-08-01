import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AppProjectList } from "./AppProjectList";
import { AppGenChat } from "./AppGenChat";
import { CodeEditor } from "./CodeEditor";
import { PreviewFrame } from "./PreviewFrame";
import { useAppProjectStore } from "@/stores/app-project";

export function AppGenLayout() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentProjectId, setCurrentProject, setFiles, setProjects } =
    useAppProjectStore();

  // Load projects on mount
  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    if (!token) {
      navigate("/login");
      return;
    }

    fetch("/api/projects", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.projects) setProjects(data.projects);
      })
      .catch(console.error);
  }, []);

  // Load project when id changes
  useEffect(() => {
    if (!id) return;

    const token = localStorage.getItem("accessToken");
    if (!token) return;

    // Set current project
    setCurrentProject(id);

    // Load project files
    fetch(`/api/projects/${id}/files`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.files) setFiles(data.files);
      })
      .catch(console.error);
  }, [id]);

  return (
    <div
      className="flex flex-1 overflow-hidden"
      style={{ height: "calc(100dvh - 48px)" }}
    >
      {/* Left sidebar: Project list */}
      <div className="w-56 flex-shrink-0 border-r border-gray-200">
        <AppProjectList />
      </div>

      {/* Center: Chat + Code */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Code Editor (takes most space) */}
        <div className="flex-1 min-h-0">
          <CodeEditor />
        </div>

        {/* Chat input area (bottom) */}
        <div className="h-48 flex-shrink-0 border-t border-gray-200">
          {currentProjectId && <AppGenChat projectId={currentProjectId} />}
        </div>
      </div>

      {/* Right: Preview panel */}
      <div className="w-96 flex-shrink-0 border-l border-gray-200 bg-white">
        <PreviewFrame />
      </div>
    </div>
  );
}
