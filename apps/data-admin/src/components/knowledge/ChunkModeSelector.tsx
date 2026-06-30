// 分块模式选择器 —— 两张可选卡片：通用分块 / 父子分块
import { FileText, GitBranch } from "lucide-react";

// ── Props ────────────────────────────────────────

interface ChunkModeSelectorProps {
  value: "general" | "parent_child";
  onChange: (mode: "general" | "parent_child") => void;
}

// ── 模式配置 ──────────────────────────────────────

interface ModeOption {
  value: "general" | "parent_child";
  title: string;
  description: string;
  icon: typeof FileText;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "general",
    title: "通用分块",
    description:
      "按段落和分隔符将文本切分为固定大小的块，适用于大多数文档类型。",
    icon: FileText,
  },
  {
    value: "parent_child",
    title: "父子分块",
    description:
      "生成两层结构的块——父块保留更完整的上下文，子块用于精确检索。适合需要保留层级语义的复杂文档。",
    icon: GitBranch,
  },
];

// ── 组件 ──────────────────────────────────────────

export function ChunkModeSelector({
  value,
  onChange,
}: ChunkModeSelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {MODE_OPTIONS.map((option) => {
        const isSelected = value === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              "flex flex-col items-start gap-3 rounded-lg border-2 p-4 text-left transition-all",
              isSelected
                ? "border-[hsl(var(--cs-primary))] bg-[hsl(var(--cs-primary-light))] shadow-sm"
                : "border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--cs-primary))]/40 hover:bg-[hsl(var(--accent))]",
            ].join(" ")}
          >
            <div
              className={[
                "flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0",
                isSelected
                  ? "bg-[hsl(var(--cs-primary))]/10 text-[hsl(var(--cs-primary))]"
                  : "bg-[hsl(var(--accent))] text-muted-foreground",
              ].join(" ")}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p
                className={[
                  "text-sm font-medium",
                  isSelected ? "text-[hsl(var(--cs-primary))]" : "text-foreground",
                ].join(" ")}
              >
                {option.title}
              </p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {option.description}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
