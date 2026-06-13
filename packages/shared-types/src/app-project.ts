// App Project types — shared between frontend and backend for WeaveFox-like app generation

// Project status
export type ProjectStatus = "draft" | "generating" | "previewing" | "deployed" | "archived";
export type ProjectType = "frontend" | "fullstack";
export type ProjectFramework = "react" | "vue" | "html" | "nextjs";
export type ProjectLanguage = "tsx" | "ts" | "css" | "html" | "json" | "js" | "py";

// Data transfer objects
export interface AppProjectDTO {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  type: ProjectType;
  framework: ProjectFramework;
  previewUrl: string | null;
  deployUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFileDTO {
  id: string;
  projectId: string;
  path: string;
  content: string;
  language: ProjectLanguage;
  size: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppGenRunDTO {
  id: string;
  projectId: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  result: AppGenRunResult | null;
  agentSessionId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AppGenRunResult {
  files_created: string[];
  tokens_used: number;
  errors: string[];
}

// Request types
export interface CreateProjectRequest {
  name: string;
  description?: string;
  prompt: string;
  framework?: ProjectFramework;
  type?: ProjectType;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: ProjectStatus;
}

export interface GenerateAppRequest {
  prompt: string;
  skills?: string[];
}

export interface WriteFileRequest {
  content: string;
  language?: ProjectLanguage;
}

// SSE stream event types for app generation
export type AppGenStreamEventType =
  | "appgen_meta"
  | "appgen_plan"
  | "appgen_file_start"
  | "appgen_file_chunk"
  | "appgen_file_done"
  | "appgen_review"
  | "appgen_done"
  | "appgen_error";

export interface AppGenStreamEvent {
  type: AppGenStreamEventType;
  message_id?: string;
  project_id?: string;
  run_id?: string;
  // meta
  name?: string;
  framework?: string;
  prompt?: string;
  // plan
  plan?: AppFilePlan[];
  // file events
  file_path?: string;
  language?: string;
  chunk?: string;
  content?: string;
  size?: number;
  // review
  review?: string;
  // done
  result?: AppGenRunResult;
  // error
  error?: string;
}

export interface AppFilePlan {
  path: string;
  language: ProjectLanguage;
  description: string;
}

// App Generation Tool definitions (used in codegen ReAct loop)
export interface PlanAppStructureOutput {
  files: AppFilePlan[];
  reasoning: string;
}

export interface GenerateFileOutput {
  path: string;
  language: ProjectLanguage;
  content: string;
}

export interface ReviewCodeOutput {
  path: string;
  issues: Array<{
    severity: "error" | "warning" | "info";
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  summary: string;
  passes: boolean;
}

export interface ModifyFileOutput {
  path: string;
  old_code: string;
  new_code: string;
  diff_summary: string;
}
