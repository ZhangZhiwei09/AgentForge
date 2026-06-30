// 上传向导第 2 步：配置分块参数 —— 左侧模式选择 + 参数，右侧预览
import type { ChunkingConfigDTO, ChunkPreviewResponseDTO } from "@agentforge/shared-types";
import { ChunkModeSelector } from "./ChunkModeSelector";
import { ChunkParameters } from "./ChunkParameters";
import { ChunkPreview } from "./ChunkPreview";
import { ArrowLeft, ArrowRight } from "lucide-react";

// ── Props ────────────────────────────────────────

interface StepChunkConfigProps {
  config: ChunkingConfigDTO;
  onConfigChange: (config: ChunkingConfigDTO) => void;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting?: boolean;
  preview: ChunkPreviewResponseDTO | null;
  previewLoading: boolean;
  previewError?: string | null;
}

// ── 组件 ──────────────────────────────────────────

export function StepChunkConfig({
  config,
  onConfigChange,
  onBack,
  onSubmit,
  isSubmitting = false,
  preview,
  previewLoading,
  previewError,
}: StepChunkConfigProps) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold text-foreground">分块设置</h3>
        <p className="text-xs text-muted-foreground">
          配置文本分块策略，确保检索效果最优
        </p>
      </div>

      {/* 左右布局 */}
      <div className="grid grid-cols-2 gap-6">
        {/* 左侧：模式选择 + 参数配置 */}
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">
              分块模式
            </label>
            <ChunkModeSelector
              value={config.mode}
              onChange={(mode) => onConfigChange({ ...config, mode })}
            />
          </div>

          <ChunkParameters config={config} onChange={onConfigChange} />
        </div>

        {/* 右侧：分块预览 */}
        <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20 p-4">
          <div className="flex items-center gap-2 mb-4">
            <h4 className="text-xs font-medium text-foreground">分块预览</h4>
            {previewLoading && (
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            )}
          </div>
          {previewError && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
              {previewError}
            </div>
          )}
          <div className="max-h-[420px] overflow-y-auto">
            <ChunkPreview preview={preview} loading={previewLoading} />
          </div>
        </div>
      </div>

      {/* 底部按钮 */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4 py-2 text-sm text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          上一步
        </button>

        <button
          onClick={onSubmit}
          disabled={isSubmitting}
          className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "保存配置中..." : "开始处理"}
          {isSubmitting ? (
            <span className="inline-block h-3 w-3 rounded-full border-2 border-[hsl(var(--primary-foreground))] border-t-transparent animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
