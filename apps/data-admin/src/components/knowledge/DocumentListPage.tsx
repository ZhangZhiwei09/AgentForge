// 文档列表页面 —— 整合工具栏 + 文档表格 + 上传向导
import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Database } from "lucide-react";
import { DocumentToolbar } from "./DocumentToolbar";
import { DocumentTable } from "./DocumentTable";
import { UploadWizard } from "./UploadWizard";

// ── Props ────────────────────────────────────────

interface DocumentListPageProps {
  kbId: string;
  kbName: string;
}

// ── 组件 ──────────────────────────────────────────

export function DocumentListPage({ kbId, kbName }: DocumentListPageProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // 上传向导开关
  const [showUploadWizard, setShowUploadWizard] = useState(false);

  // 搜索与筛选
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [uploading, setUploading] = useState(false);

  // 上传完成回调
  const handleUploadComplete = useCallback(() => {
    setShowUploadWizard(false);
    setUploading(false);
    // 刷新文档列表
    queryClient.invalidateQueries({
      queryKey: ["knowledge", "documents", kbId],
    });
  }, [queryClient, kbId]);

  return (
    <div className="flex flex-col flex-1 h-full bg-[hsl(var(--background))]">
      {/* 顶部标题栏 */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-[hsl(var(--border))]">
        <button
          onClick={() => navigate("/admin/cs/knowledge/bases")}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
          title="返回知识库列表"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <Database className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <h1 className="text-sm font-semibold text-foreground truncate">
            {kbName}
          </h1>
        </div>
        <span className="text-[10px] text-muted-foreground bg-[hsl(var(--muted))] rounded px-1.5 py-0.5 flex-shrink-0">
          文档列表
        </span>
      </div>

      {/* 工具栏 */}
      <DocumentToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onUploadClick={() => setShowUploadWizard(true)}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        uploading={uploading}
      />

      {/* 文档表格 */}
      <DocumentTable
        kbId={kbId}
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        uploading={uploading}
        onUploadClick={() => setShowUploadWizard(true)}
      />

      {/* 上传向导模态框 */}
      <UploadWizard
        kbId={kbId}
        open={showUploadWizard}
        onClose={() => {
          setShowUploadWizard(false);
          setUploading(false);
        }}
        onComplete={handleUploadComplete}
      />
    </div>
  );
}
