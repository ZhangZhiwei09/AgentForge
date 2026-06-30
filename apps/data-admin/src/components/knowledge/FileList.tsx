// 文件列表容器 —— 包含多个 FileListItem
import { FileListItem } from "./FileListItem";

// ── Props ────────────────────────────────────────

interface FileListProps {
  files: File[];
  uploadProgress: Map<string, number>;
  fileStatuses: Map<string, "pending" | "uploading" | "done" | "error">;
  onRemove: (index: number) => void;
}

// ── 组件 ──────────────────────────────────────────

export function FileList({
  files,
  uploadProgress,
  fileStatuses,
  onRemove,
}: FileListProps) {
  if (files.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          已选择 <span className="font-medium text-foreground">{files.length}</span> 个文件
        </p>
      </div>
      <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
        {files.map((file, index) => (
          <FileListItem
            key={`${file.name}-${index}`}
            file={file}
            progress={uploadProgress.get(file.name) ?? 0}
            status={fileStatuses.get(file.name) ?? "pending"}
            onRemove={() => onRemove(index)}
          />
        ))}
      </div>
    </div>
  );
}
