import { useAppProjectStore } from "@/stores/app-project";
import type { AppProjectDTO } from "@agentforge/shared-types";
import { useNavigate } from "react-router-dom";

export function AppProjectList() {
  const navigate = useNavigate();
  const { projects, currentProjectId, setCurrentProject } =
    useAppProjectStore();

  const handleNewProject = () => {
    // Navigate to the new project page
    navigate("/projects/new");
  };

  const handleSelectProject = (project: AppProjectDTO) => {
    setCurrentProject(project.id);
    navigate(`/projects/${project.id}`);
  };

  const statusColors: Record<string, string> = {
    draft: "bg-gray-300",
    generating: "bg-yellow-400 animate-pulse",
    previewing: "bg-green-400",
    deployed: "bg-blue-500",
    archived: "bg-gray-500",
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-200">
      {/* Header */}
      <div className="p-3 border-b border-gray-700">
        <button
          onClick={handleNewProject}
          className="w-full py-2 px-3 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >
          + New Project
        </button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {projects.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            <div className="mb-2 text-2xl">🦊</div>
            <div>No projects yet</div>
            <div className="text-xs mt-1">Create your first app!</div>
          </div>
        ) : (
          projects.map((project) => (
            <button
              key={project.id}
              onClick={() => handleSelectProject(project)}
              className={`w-full text-left p-3 border-b border-gray-800 hover:bg-gray-800 transition-colors ${
                currentProjectId === project.id
                  ? "bg-gray-800 border-l-2 border-l-blue-500"
                  : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    statusColors[project.status] || "bg-gray-500"
                  }`}
                />
                <span className="text-sm font-medium truncate">
                  {project.name}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 ml-4">
                <span className="text-xs text-gray-500">
                  {project.framework}
                </span>
                <span className="text-xs text-gray-600">•</span>
                <span className="text-xs text-gray-500 capitalize">
                  {project.status}
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* User info */}
      <div className="p-3 border-t border-gray-700 text-xs text-gray-500">
        AgentForge Studio v1.0
      </div>
    </div>
  );
}
