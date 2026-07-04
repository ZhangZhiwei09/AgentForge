// 知识库卡片 —— 名称 / 描述 / 文档数 / 分块结构 / 可用状态 / 操作菜单
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Database,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  Layers,
} from "lucide-react";
import type { KnowledgeBaseDTO } from "@agentforge/shared-types";

// ── 确认删除对话框 ──────────────────────────────────

function ConfirmDeleteModal({
  open,
  kbName,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  kbName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[360px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          确认删除
        </h3>
        <p className="text-xs text-muted-foreground mb-5">
          确定要删除知识库「{kbName}」吗？此操作不可撤销，所有文档和分块数据将被永久删除。
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────

interface KnowledgeBaseCardProps {
  kb: KnowledgeBaseDTO;
  onDelete: (kbId: string) => void;
}

// ── 组件 ──────────────────────────────────────────

export function KnowledgeBaseCard({ kb, onDelete }: KnowledgeBaseCardProps) {
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleEnter = () => {
    navigate(`/admin/cs/knowledge/bases/${kb.id}`);
  };

  const handleDelete = () => {
    onDelete(kb.id);
    setShowDeleteConfirm(false);
    setShowMenu(false);
  };

  return (
    <>
      <div
        className="group cursor-pointer rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--ring))]/50 hover:shadow-md"
        onClick={handleEnter}
      >
        {/* 头部：图标 + 名称 + 更多菜单 */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex-shrink-0 rounded-lg bg-[hsl(var(--primary))]/10 p-2">
              <Database className="h-4 w-4 text-[hsl(var(--primary))]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate">
                {kb.name}
              </h3>
            </div>
          </div>

          {/* 更多菜单按钮 */}
          <div className="relative flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              className="p-1 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-[hsl(var(--accent))] transition-all"
              title="更多操作"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {/* 下拉菜单 */}
            {showMenu && (
              <div className="absolute right-0 top-full mt-1 w-36 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-lg z-10 py-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(false);
                    // 编辑功能后续阶段集成 CreateKnowledgeBaseDialog
                    handleEnter();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  编辑
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(false);
                    setShowDeleteConfirm(true);
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 描述 */}
        {kb.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
            {kb.description}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic mb-3">
            暂无描述
          </p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* 文档数 */}
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <FileText className="h-3 w-3" />
              {kb.document_count} 篇文档
            </span>

            {/* 分块结构标签 */}
            <span className="inline-flex items-center gap-1 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Layers className="h-2.5 w-2.5" />
              通用
            </span>
          </div>

          {/* 可用状态 */}
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
              kb.enabled
                ? "bg-green-100 text-green-700"
                : "bg-amber-100 text-amber-700"
            }`}
          >
            {kb.enabled ? "可用" : "已禁用"}
          </span>
        </div>
      </div>

      {/* 删除确认对话框 */}
      <ConfirmDeleteModal
        open={showDeleteConfirm}
        kbName={kb.name}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  );
}
