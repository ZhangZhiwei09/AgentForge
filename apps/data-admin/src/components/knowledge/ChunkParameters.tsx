// 分块参数配置表单 —— 分隔符、分块大小、重叠、预处理规则、父分块参数
import type { ChunkingConfigDTO } from "@agentforge/shared-types";

// ── Props ────────────────────────────────────────

interface ChunkParametersProps {
  config: ChunkingConfigDTO;
  onChange: (config: ChunkingConfigDTO) => void;
}

// ── 滑块组件 ──────────────────────────────────────

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs text-foreground">{label}</label>
        <span className="text-xs font-mono text-muted-foreground tabular-nums">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-[hsl(var(--border))] accent-[hsl(var(--cs-primary))] cursor-pointer"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
}

// ── 复选框组件 ────────────────────────────────────

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-[hsl(var(--border))] accent-[hsl(var(--cs-primary))] cursor-pointer"
      />
      <span className="text-xs text-foreground">{label}</span>
    </label>
  );
}

// ── 组件 ──────────────────────────────────────────

export function ChunkParameters({ config, onChange }: ChunkParametersProps) {
  const isHierarchical = config.mode === "parent_child";

  const update = (partial: Partial<ChunkingConfigDTO>) =>
    onChange({ ...config, ...partial });

  return (
    <div className="space-y-5">
      {/* 分隔符模式 */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">分隔符</label>
        <div className="flex gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="separator_mode"
              checked={!config.separator}
              onChange={() => update({ separator: "" })}
              className="accent-[hsl(var(--cs-primary))]"
            />
            <span className="text-xs text-foreground">自动</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="separator_mode"
              checked={!!config.separator}
              onChange={() => update({ separator: "\n\n" })}
              className="accent-[hsl(var(--cs-primary))]"
            />
            <span className="text-xs text-foreground">自定义</span>
          </label>
        </div>
        {config.separator && (
          <input
            type="text"
            value={config.separator}
            onChange={(e) => update({ separator: e.target.value })}
            placeholder="输入自定义分隔符（如 \n\n）"
            className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
          />
        )}
      </div>

      {/* 分块大小滑块 */}
      <SliderField
        label="分块大小"
        value={config.maxChunkSize}
        min={50}
        max={4000}
        step={50}
        unit=" tokens"
        onChange={(v) => update({ maxChunkSize: v })}
      />

      {/* 重叠大小滑块 */}
      <SliderField
        label="重叠大小"
        value={config.overlap}
        min={0}
        max={Math.floor(config.maxChunkSize / 2)}
        step={10}
        unit=" tokens"
        onChange={(v) => update({ overlap: v })}
      />

      {/* 父子分块参数（仅 hierarchical 模式显示） */}
      {isHierarchical && (
        <>
          <div className="border-t border-[hsl(var(--border))] pt-4">
            <p className="text-xs font-medium text-foreground mb-3">
              父分块参数
            </p>
            <div className="space-y-4">
              <SliderField
                label="父块大小"
                value={config.parentMaxSize ?? 2000}
                min={500}
                max={8000}
                step={100}
                unit=" tokens"
                onChange={(v) => update({ parentMaxSize: v })}
              />
              <SliderField
                label="子块大小"
                value={config.childMaxSize ?? 500}
                min={50}
                max={Math.min(config.parentMaxSize ?? 2000, 4000)}
                step={50}
                unit=" tokens"
                onChange={(v) => update({ childMaxSize: v })}
              />
            </div>
          </div>
        </>
      )}

      {/* 预处理规则 */}
      <div className="border-t border-[hsl(var(--border))] pt-4">
        <p className="text-xs font-medium text-foreground mb-3">预处理规则</p>
        <div className="space-y-2.5">
          <CheckboxField
            label="移除多余空格和空行"
            checked={config.removeExtraSpaces}
            onChange={(v) => update({ removeExtraSpaces: v })}
          />
          <CheckboxField
            label="移除 URL 和邮箱地址"
            checked={config.removeUrlsEmails}
            onChange={(v) => update({ removeUrlsEmails: v })}
          />
        </div>
      </div>
    </div>
  );
}
