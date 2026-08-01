// ── 表格卡片 ──
// 替代降级 Markdown 表格渲染，提供原生 <table> + 交替行色等样式

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";
import type { TableBlockData } from "@agentforge/shared-types";

// ── CVA ──

const tableVariants = cva("my-2 w-full border-collapse overflow-hidden rounded-lg border border-slate-200 text-xs", {
  variants: {
    size: {
      sm: "text-[10px]",
      md: "text-xs",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

type TableVariantProps = VariantProps<typeof tableVariants>;

// ── Props ──

interface Props extends TableVariantProps {
  data: TableBlockData;
  isStreaming?: boolean;
  className?: string;
}

// ── 骨架 ──

function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-pulse rounded bg-slate-200", className)}
    >
      &nbsp;
    </span>
  );
}

// ── 组件 ──

export function TableCard({ data, size, isStreaming, className }: Props) {
  if (isStreaming && (!data.headers || data.headers.length === 0)) {
    return (
      <div className={cn("my-2 p-3 rounded-lg border border-slate-200 bg-white", className)}>
        <Skeleton className="w-full h-6 mb-1" />
        <Skeleton className="w-full h-4 mb-1" />
        <Skeleton className="w-full h-4 mb-1" />
        <Skeleton className="w-2/3 h-4" />
      </div>
    );
  }

  return (
    <div className={cn("my-2 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      <table className={tableVariants({ size })}>
        {data.caption && (
          <caption className="px-3 py-2 text-[10px] text-slate-500 text-left bg-slate-50 border-b border-slate-200">
            {data.caption}
          </caption>
        )}
        <thead>
          <tr className="bg-slate-100">
            {data.headers.map((header, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-slate-200"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className={cn(
                "border-b border-slate-100 last:border-b-0",
                rowIdx % 2 === 0 ? "bg-white" : "bg-slate-50/50",
              )}
            >
              {row.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  className="px-3 py-2 text-slate-600"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TableCard;
