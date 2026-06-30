// 上传向导状态管理 — 步骤、文件列表、分块配置
import { create } from "zustand";
import type { ChunkingConfigDTO } from "@agentforge/shared-types";

// ── 默认分块配置 ──────────────────────────────────

const DEFAULT_CONFIG: ChunkingConfigDTO = {
  mode: "general",
  separator: "",
  maxChunkSize: 500,
  overlap: 50,
  removeExtraSpaces: true,
  removeUrlsEmails: false,
};

// ── Store 接口 ───────────────────────────────────

export interface UploadWizardState {
  /** 当前步骤：1=上传文档, 2=分块设置, 3=处理进度 */
  step: number;
  /** 已选择的文件列表 */
  files: File[];
  /** 分块配置 */
  config: ChunkingConfigDTO;
  /** 上传进度映射（文件名 → 0-100） */
  uploadProgress: Map<string, number>;
  /** 文件上传状态映射（文件名 → 状态） */
  fileStatuses: Map<string, "pending" | "uploading" | "done" | "error">;

  // 动作
  setStep: (step: number) => void;
  setFiles: (files: File[]) => void;
  addFiles: (newFiles: File[]) => void;
  removeFile: (index: number) => void;
  setConfig: (config: ChunkingConfigDTO) => void;
  updateConfig: (partial: Partial<ChunkingConfigDTO>) => void;
  setUploadProgress: (fileName: string, progress: number) => void;
  setFileStatus: (
    fileName: string,
    status: "pending" | "uploading" | "done" | "error",
  ) => void;
  reset: () => void;
}

// ── Store 实现 ───────────────────────────────────

export const useUploadWizardStore = create<UploadWizardState>()((set) => ({
  step: 1,
  files: [],
  config: { ...DEFAULT_CONFIG },
  uploadProgress: new Map(),
  fileStatuses: new Map(),

  setStep: (step) => set({ step }),

  setFiles: (files) => set({ files }),

  addFiles: (newFiles) =>
    set((state) => ({ files: [...state.files, ...newFiles] })),

  removeFile: (index) =>
    set((state) => ({
      files: state.files.filter((_, i) => i !== index),
    })),

  setConfig: (config) => set({ config }),

  updateConfig: (partial) =>
    set((state) => ({ config: { ...state.config, ...partial } })),

  setUploadProgress: (fileName, progress) =>
    set((state) => {
      const next = new Map(state.uploadProgress);
      next.set(fileName, progress);
      return { uploadProgress: next };
    }),

  setFileStatus: (fileName, status) =>
    set((state) => {
      const next = new Map(state.fileStatuses);
      next.set(fileName, status);
      return { fileStatuses: next };
    }),

  reset: () =>
    set({
      step: 1,
      files: [],
      config: { ...DEFAULT_CONFIG },
      uploadProgress: new Map(),
      fileStatuses: new Map(),
    }),
}));
