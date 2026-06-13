import { create } from "zustand";
import type { AppProjectDTO, ProjectFileDTO, AppGenRunDTO, AppFilePlan } from "@agentforge/shared-types";

export type AppGenStatus = "idle" | "planning" | "generating" | "reviewing" | "done" | "error";

interface AppProjectState {
  // Project list
  projects: AppProjectDTO[];
  currentProjectId: string | null;

  // Current project details
  files: ProjectFileDTO[];
  activeFilePath: string | null;
  activeFileContent: string;

  // Generation state
  isGenerating: boolean;
  genStatus: AppGenStatus;
  genRunId: string | null;
  genPlan: AppFilePlan[];
  genErrors: string[];
  genTokensUsed: number;

  // UI state
  showFileTree: boolean;
  showPreview: boolean;
  editMode: boolean;
  previewHtml: string;

  // Actions
  setProjects: (projects: AppProjectDTO[]) => void;
  setCurrentProject: (id: string | null) => void;
  setFiles: (files: ProjectFileDTO[]) => void;
  addFile: (file: ProjectFileDTO) => void;
  setActiveFile: (path: string | null) => void;
  setActiveFileContent: (content: string) => void;
  setIsGenerating: (v: boolean) => void;
  setGenStatus: (status: AppGenStatus) => void;
  setGenRunId: (id: string | null) => void;
  setGenPlan: (plan: AppFilePlan[]) => void;
  addGenError: (error: string) => void;
  clearGenErrors: () => void;
  addGenTokens: (tokens: number) => void;
  toggleFileTree: () => void;
  togglePreview: () => void;
  setEditMode: (v: boolean) => void;
  setPreviewHtml: (html: string) => void;
  resetGen: () => void;
}

export const useAppProjectStore = create<AppProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  files: [],
  activeFilePath: null,
  activeFileContent: "",
  isGenerating: false,
  genStatus: "idle",
  genRunId: null,
  genPlan: [],
  genErrors: [],
  genTokensUsed: 0,
  showFileTree: true,
  showPreview: true,
  editMode: false,
  previewHtml: "",

  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) =>
    set({
      currentProjectId: id,
      files: [],
      activeFilePath: null,
      activeFileContent: "",
      genStatus: "idle",
      genPlan: [],
      genErrors: [],
      genTokensUsed: 0,
    }),
  setFiles: (files) => {
    set({ files });
    // Auto-select first file if none selected
    if (files.length > 0 && !get().activeFilePath) {
      set({
        activeFilePath: files[0].path,
        activeFileContent: files[0].content,
      });
    }
  },
  addFile: (file) =>
    set((s) => ({
      files: [...s.files.filter((f) => f.path !== file.path), file],
      activeFilePath: s.activeFilePath || file.path,
      activeFileContent: s.activeFilePath === file.path ? file.content : s.activeFileContent,
    })),
  setActiveFile: (path) => {
    if (!path) {
      set({ activeFilePath: null, activeFileContent: "" });
      return;
    }
    const file = get().files.find((f) => f.path === path);
    set({
      activeFilePath: path,
      activeFileContent: file?.content || "",
    });
  },
  setActiveFileContent: (content) => set({ activeFileContent: content }),
  setIsGenerating: (v) => set({ isGenerating: v }),
  setGenStatus: (status) => set({ genStatus: status }),
  setGenRunId: (id) => set({ genRunId: id }),
  setGenPlan: (plan) => set({ genPlan: plan }),
  addGenError: (error) => set((s) => ({ genErrors: [...s.genErrors, error] })),
  clearGenErrors: () => set({ genErrors: [] }),
  addGenTokens: (tokens) => set((s) => ({ genTokensUsed: s.genTokensUsed + tokens })),
  toggleFileTree: () => set((s) => ({ showFileTree: !s.showFileTree })),
  togglePreview: () => set((s) => ({ showPreview: !s.showPreview })),
  setEditMode: (v) => set({ editMode: v }),
  setPreviewHtml: (html) => set({ previewHtml: html }),
  resetGen: () =>
    set({
      isGenerating: false,
      genStatus: "idle",
      genRunId: null,
      genPlan: [],
      genErrors: [],
      genTokensUsed: 0,
    }),
}));
