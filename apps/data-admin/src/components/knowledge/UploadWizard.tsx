// 上传向导 —— 3 步编排器：上传文档 → 分块设置 → 处理进度
import { useState, useMemo, useCallback, useEffect } from "react";
import { X } from "lucide-react";
import { AgentForgeClient } from "@agentforge/sdk";
import type {
  ChunkPreviewResponseDTO,
} from "@agentforge/shared-types";
import { useUploadWizardStore } from "./UploadWizardStore";
import { StepDataSource } from "./StepDataSource";
import { StepChunkConfig } from "./StepChunkConfig";
import { StepProcessing } from "./StepProcessing";
import type { DocumentSnapshot } from "../../hooks/useProcessingPolling";

// ── 步骤定义 ──────────────────────────────────────

const STEPS = [
  { key: 1, label: "上传文档" },
  { key: 2, label: "分块设置" },
  { key: 3, label: "处理进度" },
] as const;

// ── 已上传文档类型 ────────────────────────────────

interface ProcessingDocument {
  id: string;
  title: string;
  status: string;
}

// ── Props ────────────────────────────────────────

interface UploadWizardProps {
  kbId: string;
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

// ── 读取文件文本内容 ──────────────────────────────

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error(`无法读取文件 ${file.name}`));
    reader.readAsText(file);
  });
}

/** 判断文件是否为可读文本类型（用于分块预览采样） */
function isTextFile(file: File): boolean {
  const textExtensions = [".txt", ".md", ".markdown", ".json", ".csv", ".html", ".xml", ".yaml", ".yml", ".log"];
  const name = file.name.toLowerCase();
  return textExtensions.some((ext) => name.endsWith(ext));
}

// ── 组件 ──────────────────────────────────────────

export function UploadWizard({
  kbId,
  open,
  onClose,
  onComplete,
}: UploadWizardProps) {
  const store = useUploadWizardStore();
  const { step, files, config, uploadProgress, fileStatuses } = store;

  // 已上传文档（步骤 2 → 3 传递）
  const [uploadedDocs, setUploadedDocs] = useState<ProcessingDocument[]>([]);
  // 上传中标记
  const [uploading, setUploading] = useState(false);
  // 分块预览
  const [preview, setPreview] = useState<ChunkPreviewResponseDTO | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // 采样文本（用于预览）
  const [sampleText, setSampleText] = useState("");
  // 上传错误
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── SDK 客户端 ──────────────────────────────────

  const client = useMemo(
    () =>
      new AgentForgeClient({
        baseUrl: "",
        getAccessToken: () => localStorage.getItem("accessToken"),
        onAuthError: () => {
          localStorage.removeItem("accessToken");
          if (window.location.pathname !== "/login") {
            window.location.href = "/login";
          }
        },
      }),
    [],
  );

  // ── 文档轮询回调 ────────────────────────────────

  const fetchDocument = useCallback(
    async (docId: string): Promise<DocumentSnapshot> => {
      const doc = await client.getDocument(docId);
      // API 返回字段多于 KnowledgeDocumentDTO 定义（含阶段时间戳与处理详情），安全扩展访问
      const fullDoc = doc as typeof doc & {
        processingDetail?: DocumentSnapshot["processingDetail"];
        downloadingCompletedAt?: string | null;
        parsingCompletedAt?: string | null;
        normalizingCompletedAt?: string | null;
        chunkingCompletedAt?: string | null;
        embeddingCompletedAt?: string | null;
      };
      return {
        status: fullDoc.status,
        originalFilename: fullDoc.originalFilename ?? null,
        processingDetail: fullDoc.processingDetail ?? null,
        downloadingCompletedAt: fullDoc.downloadingCompletedAt ?? null,
        parsingCompletedAt: fullDoc.parsingCompletedAt ?? null,
        normalizingCompletedAt: fullDoc.normalizingCompletedAt ?? null,
        chunkingCompletedAt: fullDoc.chunkingCompletedAt ?? null,
        embeddingCompletedAt: fullDoc.embeddingCompletedAt ?? null,
      };
    },
    [client],
  );

  // ── 步骤 1 → 2：上传文件 ───────────────────────

  const handleUploadAndNext = useCallback(async () => {
    if (files.length === 0) return;

    setUploading(true);
    setUploadError(null);
    const docs: ProcessingDocument[] = [];
    let sampleContent = "";

    for (const file of files) {
      store.setFileStatus(file.name, "uploading");
      store.setUploadProgress(file.name, 0);
      try {
        const doc = await client.uploadDocumentFile(kbId, file, {
          title: file.name,
          process: false, // 延迟入队：等 Step 2 保存分块配置后再触发
        });
        docs.push({ id: doc.id, title: doc.title, status: doc.status });
        store.setUploadProgress(file.name, 100);
        store.setFileStatus(file.name, "done");

        // 采样第一个可读文本文件用于分块预览
        if (!sampleContent && isTextFile(file)) {
          try {
            sampleContent = await readFileAsText(file);
          } catch {
            // 读取失败不影响上传流程
          }
        }
      } catch (e) {
        store.setFileStatus(file.name, "error");
        setUploadError(
          e instanceof Error ? e.message : `文件 ${file.name} 上传失败`,
        );
      }
    }

    setUploadedDocs(docs);
    setSampleText(sampleContent);
    setUploading(false);

    // 全部失败则不进入下一步
    if (docs.length === 0) {
      return;
    }
    store.setStep(2);
  }, [files, kbId, client, store]);

  // ── 步骤 2：分块预览（防抖） ────────────────────

  // 当 config 变化时触发预览请求
  useEffect(() => {
    if (step !== 2 || !sampleText) return;

    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const result = await client.previewChunks(sampleText, config);
        setPreview(result);
      } catch (e) {
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : "分块预览请求失败");
      } finally {
        setPreviewLoading(false);
      }
    }, 400); // 400ms 防抖

    return () => clearTimeout(timer);
  }, [step, config, sampleText, client]);

  // ── 步骤 2 → 3：保存分块配置到知识库，然后开始处理 ───

  const [savingConfig, setSavingConfig] = useState(false);
  const handleStartProcessing = useCallback(async () => {
    setSavingConfig(true);
    try {
      // 自动 clamp overlap：后端校验要求 overlap < size * 0.5，避免 400
      const clampOverlap = (size: number, overlap: number) =>
        Math.min(overlap, Math.max(0, Math.floor(size * 0.5) - 1));

      const parentSize = config.maxChunkSize;
      const parentOverlap = clampOverlap(parentSize, config.overlap);
      const childSize = config.childMaxSize ?? parentSize;
      // 链式 clamp：childOverlap 基于已 clamp 的 parentOverlap，与 SDK previewChunks 保持一致
      const childOverlap = clampOverlap(childSize, parentOverlap);

      // 1. 将分块配置写入知识库，确保 Worker 处理时使用正确的参数
      await client.updateKnowledgeBase(kbId, {
        chunk_size_tokens: parentSize,
        chunk_overlap_tokens: parentOverlap,
        separator_mode: config.separator ? "custom" : "auto",
        custom_separator: config.separator || null,
        chunk_structure: config.mode === "parent_child" ? "hierarchical" : "paragraph",
        child_chunk_size_tokens: config.mode === "parent_child" ? childSize : null,
        child_chunk_overlap_tokens: config.mode === "parent_child" ? childOverlap : null,
        remove_extra_spaces: config.removeExtraSpaces,
        remove_urls_emails: config.removeUrlsEmails,
      });

      // 2. 配置已保存，现在触发文档处理（Step 1 上传时跳过了入队）
      await client.processKnowledgeBase(kbId);

      store.setStep(3);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "保存分块配置失败");
    } finally {
      setSavingConfig(false);
    }
  }, [kbId, config, client, store]);

  // ── 完成 ───────────────────────────────────────

  const handleGoToDocuments = useCallback(() => {
    store.reset();
    setUploadedDocs([]);
    setPreview(null);
    setPreviewError(null);
    setSampleText("");
    setUploadError(null);
    onComplete();
  }, [store, onComplete]);

  // ── 关闭 ───────────────────────────────────────

  const handleClose = useCallback(() => {
    store.reset();
    setUploadedDocs([]);
    setPreview(null);
    setSampleText("");
    setUploadError(null);
    onClose();
  }, [store, onClose]);

  // ── 渲染 ───────────────────────────────────────

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      {/* 模态容器 */}
      <div className="w-[720px] max-h-[85vh] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-2xl flex flex-col overflow-hidden animate-fade-in">
        {/* 头部：步骤指示器 + 关闭按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
          {/* 步骤指示器 */}
          <div className="flex items-center gap-2">
            {STEPS.map((s, index) => (
              <div key={s.key} className="flex items-center gap-2">
                {/* 步骤编号圆点 */}
                <div
                  className={[
                    "flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold transition-all",
                    step === s.key
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                      : step > s.key
                        ? "bg-green-500 text-white"
                        : "bg-[hsl(var(--muted))] text-muted-foreground",
                  ].join(" ")}
                >
                  {step > s.key ? (
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    s.key
                  )}
                </div>
                {/* 步骤标签 */}
                <span
                  className={[
                    "text-sm font-medium",
                    step === s.key
                      ? "text-foreground"
                      : step > s.key
                        ? "text-green-600"
                        : "text-muted-foreground",
                  ].join(" ")}
                >
                  {s.label}
                </span>
                {/* 连接线 */}
                {index < STEPS.length - 1 && (
                  <div
                    className={[
                      "w-6 h-0.5",
                      step > s.key
                        ? "bg-green-400"
                        : "bg-[hsl(var(--border))]",
                    ].join(" ")}
                  />
                )}
              </div>
            ))}
          </div>

          {/* 关闭按钮 */}
          <button
            onClick={handleClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {/* 步骤 1：上传文档 */}
          {step === 1 && (
            <StepDataSource
              files={files}
              onFilesChange={store.setFiles}
              onNext={handleUploadAndNext}
              uploading={uploading}
              uploadProgress={uploadProgress}
              fileStatuses={fileStatuses}
              onRemoveFile={store.removeFile}
            />
          )}

          {/* 上传错误 */}
          {uploadError && (
            <div className="mt-4 px-4 py-2 rounded-md bg-red-50 border border-red-200">
              <p className="text-xs text-red-600">{uploadError}</p>
            </div>
          )}

          {/* 步骤 2：分块设置 */}
          {step === 2 && (
            <StepChunkConfig
              config={config}
              onConfigChange={store.setConfig}
              onBack={() => store.setStep(1)}
              onSubmit={handleStartProcessing}
              isSubmitting={savingConfig}
              preview={preview}
              previewLoading={previewLoading}
              previewError={previewError}
            />
          )}

          {/* 步骤 3：处理进度 */}
          {step === 3 && (
            <StepProcessing
              documents={uploadedDocs}
              kbId={kbId}
              onGoToDocuments={handleGoToDocuments}
              fetchDocument={fetchDocument}
            />
          )}
        </div>
      </div>
    </div>
  );
}
