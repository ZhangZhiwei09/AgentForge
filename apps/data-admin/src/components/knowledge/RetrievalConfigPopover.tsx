// 检索配置弹出面板 —— Top-K / Reranking / 分数阈值
import { useRef, useEffect } from "react";
import type { HitTestingRequestDTO } from "@agentforge/shared-types";
import { X } from "lucide-react";

// ── Props ────────────────────────────────────────

interface RetrievalConfigPopoverProps {
  config: HitTestingRequestDTO;
  onChange: (config: HitTestingRequestDTO) => void;
  onClose: () => void;
}

// ── 组件 ──────────────────────────────────────────

export function RetrievalConfigPopover({
  config,
  onChange,
  onClose,
}: RetrievalConfigPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Escape 键关闭
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const update = (partial: Partial<HitTestingRequestDTO>) => {
    onChange({ ...config, ...partial });
  };

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 shadow-lg animate-fade-in"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold text-foreground">检索配置</h4>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-4">
        {/* Top-K 滑块 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-muted-foreground">Top-K</label>
            <span className="text-[11px] font-mono font-medium text-foreground">
              {config.topK ?? 10}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            value={config.topK ?? 10}
            onChange={(e) => update({ topK: Number(e.target.value) })}
            className="w-full h-1.5 rounded-full appearance-none bg-[hsl(var(--muted))] cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[hsl(var(--primary))]
              [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>1</span>
            <span>20</span>
          </div>
        </div>

        {/* Reranking 开关 */}
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-muted-foreground">Reranking</label>
          <button
            role="switch"
            aria-checked={config.rerankingEnable ?? true}
            onClick={() => update({ rerankingEnable: !(config.rerankingEnable ?? true) })}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              (config.rerankingEnable ?? true)
                ? "bg-[hsl(var(--primary))]"
                : "bg-[hsl(var(--muted))] border border-[hsl(var(--border))]"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                (config.rerankingEnable ?? true) ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>

        {/* 分数阈值启用开关 */}
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-muted-foreground">
            分数阈值过滤
          </label>
          <button
            role="switch"
            aria-checked={(config.scoreThreshold ?? 0) > 0}
            onClick={() =>
              update({
                scoreThreshold:
                  (config.scoreThreshold ?? 0) > 0 ? 0 : 0.5,
              })
            }
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              (config.scoreThreshold ?? 0) > 0
                ? "bg-[hsl(var(--primary))]"
                : "bg-[hsl(var(--muted))] border border-[hsl(var(--border))]"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                (config.scoreThreshold ?? 0) > 0 ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>

        {/* 分数阈值滑块（仅在启用时显示） */}
        {(config.scoreThreshold ?? 0) > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-muted-foreground">
                最低分数
              </label>
              <span className="text-[11px] font-mono font-medium text-foreground">
                {config.scoreThreshold?.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.scoreThreshold ?? 0.5}
              onChange={(e) =>
                update({ scoreThreshold: Number(e.target.value) })
              }
              className="w-full h-1.5 rounded-full appearance-none bg-[hsl(var(--muted))] cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[hsl(var(--primary))]
                [&::-webkit-slider-thumb]:cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0</span>
              <span>1.0</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
