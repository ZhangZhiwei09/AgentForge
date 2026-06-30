// 创建 / 编辑知识库对话框 —— 名称 / 描述 / 分块结构 / 分隔符 / 分块大小 / 预处理规则
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Database } from "lucide-react";
import { client } from "@agentforge/ui";
import type {
  KnowledgeBaseDTO,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
} from "@agentforge/shared-types";

// ── 表单数据类型 ────────────────────────────────────

interface FormData {
  name: string;
  description: string;
  chunkStructure: "paragraph" | "hierarchical";
  separatorMode: "auto" | "custom";
  customSeparator: string;
  maxChunkSize: number;
  overlap: number;
  childMaxSize: number;
  childOverlap: number;
  removeExtraSpaces: boolean;
  removeUrlsEmails: boolean;
}

const DEFAULT_FORM: FormData = {
  name: "",
  description: "",
  chunkStructure: "paragraph",
  separatorMode: "auto",
  customSeparator: "",
  maxChunkSize: 500,
  overlap: 50,
  childMaxSize: 200,
  childOverlap: 20,
  removeExtraSpaces: true,
  removeUrlsEmails: false,
};

// ── Props ──────────────────────────────────────────

interface CreateKnowledgeBaseDialogProps {
  open: boolean;
  onClose: () => void;
  kb?: KnowledgeBaseDTO; // 编辑模式时传入
  onSuccess: () => void;
}

// ── 组件 ──────────────────────────────────────────

export function CreateKnowledgeBaseDialog({
  open,
  onClose,
  kb,
  onSuccess,
}: CreateKnowledgeBaseDialogProps) {
  const isEdit = !!kb;
  const [form, setForm] = useState<FormData>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);

  // 编辑模式：预填现有数据
  useEffect(() => {
    if (kb) {
      setForm({
        ...DEFAULT_FORM,
        name: kb.name,
        description: kb.description ?? "",
      });
    } else {
      setForm(DEFAULT_FORM);
    }
    setError(null);
  }, [kb, open]);

  // 更新表单字段
  const updateField = <K extends keyof FormData>(
    key: K,
    value: FormData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  // 创建 mutation
  const createMutation = useMutation({
    mutationFn: (data: CreateKnowledgeBaseRequest) =>
      client.createKnowledgeBase(data),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  // 编辑 mutation
  const updateMutation = useMutation({
    mutationFn: (data: UpdateKnowledgeBaseRequest) =>
      client.updateKnowledgeBase(kb!.id, data),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  // 提交
  const handleSubmit = () => {
    if (!form.name.trim()) {
      setError("请输入知识库名称");
      return;
    }

    // 分块配置暂不通过 KB 创建 API 传递，仅保存基本字段
    // 分块配置通过文档级别的 ChunkingConfigDTO 传递
    if (isEdit && kb) {
      updateMutation.mutate({
        name: form.name.trim(),
        description: form.description.trim() || null,
      });
    } else {
      createMutation.mutate({
        name: form.name.trim(),
        description: form.description.trim() || null,
      });
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[560px] max-h-[85vh] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-2xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {isEdit ? "编辑知识库" : "创建知识库"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* 名称（必填） */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="输入知识库名称"
              className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>

          {/* 描述（选填） */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              描述
            </label>
            <textarea
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="输入知识库描述（选填）"
              rows={2}
              className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))] resize-none"
            />
          </div>

          {/* 分块结构 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              分块结构
            </label>
            <div className="flex rounded-md border border-[hsl(var(--border))] overflow-hidden">
              <button
                onClick={() => updateField("chunkStructure", "paragraph")}
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.chunkStructure === "paragraph"
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                段落（通用）
              </button>
              <button
                onClick={() => updateField("chunkStructure", "hierarchical")}
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.chunkStructure === "hierarchical"
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                层次
              </button>
            </div>
          </div>

          {/* 分隔符模式 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              分隔符模式
            </label>
            <div className="flex rounded-md border border-[hsl(var(--border))] overflow-hidden">
              <button
                onClick={() => {
                  updateField("separatorMode", "auto");
                  updateField("customSeparator", "");
                }}
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.separatorMode === "auto"
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                自动
              </button>
              <button
                onClick={() => updateField("separatorMode", "custom")}
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.separatorMode === "custom"
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                自定义
              </button>
            </div>
          </div>

          {/* 自定义分隔符（仅自定义模式显示） */}
          {form.separatorMode === "custom" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                自定义分隔符
              </label>
              <input
                type="text"
                value={form.customSeparator}
                onChange={(e) =>
                  updateField("customSeparator", e.target.value)
                }
                placeholder="输入分隔符，如 \n\n"
                className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
              />
            </div>
          )}

          {/* 分块大小 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              分块大小（tokens）
            </label>
            <input
              type="number"
              value={form.maxChunkSize}
              onChange={(e) =>
                updateField("maxChunkSize", Number(e.target.value))
              }
              min={50}
              max={4000}
              className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
            />
            <p className="text-[10px] text-muted-foreground">
              范围：50 - 4000 tokens
            </p>
          </div>

          {/* 分块重叠 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              分块重叠（tokens）
            </label>
            <input
              type="number"
              value={form.overlap}
              onChange={(e) =>
                updateField("overlap", Number(e.target.value))
              }
              min={0}
              max={form.maxChunkSize - 1}
              className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
            />
          </div>

          {/* 子分块设置（仅层次模式显示） */}
          {form.chunkStructure === "hierarchical" && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  子分块大小（tokens）
                </label>
                <input
                  type="number"
                  value={form.childMaxSize}
                  onChange={(e) =>
                    updateField("childMaxSize", Number(e.target.value))
                  }
                  min={20}
                  max={form.maxChunkSize}
                  className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  子分块重叠（tokens）
                </label>
                <input
                  type="number"
                  value={form.childOverlap}
                  onChange={(e) =>
                    updateField("childOverlap", Number(e.target.value))
                  }
                  min={0}
                  max={form.childMaxSize - 1}
                  className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
                />
              </div>
            </>
          )}

          {/* 预处理规则 */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">
              预处理规则
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.removeExtraSpaces}
                onChange={(e) =>
                  updateField("removeExtraSpaces", e.target.checked)
                }
                className="rounded border-[hsl(var(--border))] text-[hsl(var(--primary))] focus:ring-[hsl(var(--ring))]"
              />
              <span className="text-xs text-foreground">
                移除多余空格
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.removeUrlsEmails}
                onChange={(e) =>
                  updateField("removeUrlsEmails", e.target.checked)
                }
                className="rounded border-[hsl(var(--border))] text-[hsl(var(--primary))] focus:ring-[hsl(var(--ring))]"
              />
              <span className="text-xs text-foreground">
                移除 URL 和邮件地址
              </span>
            </label>
          </div>

          {/* 错误消息 */}
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[hsl(var(--border))]">
          <button
            onClick={onClose}
            disabled={isPending}
            className="rounded-md border border-[hsl(var(--border))] px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending || !form.name.trim()}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isPending ? "保存中..." : isEdit ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
