// 上传向导第 1 步：选择文件并上传
import { FileDropzone } from "./FileDropzone";
import { FileList } from "./FileList";

// ── Props ────────────────────────────────────────

interface StepDataSourceProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  onNext: () => void;
  uploading: boolean;
  uploadProgress: Map<string, number>;
  fileStatuses: Map<string, "pending" | "uploading" | "done" | "error">;
  onRemoveFile: (index: number) => void;
}

// ── 组件 ──────────────────────────────────────────

export function StepDataSource({
  files,
  onFilesChange,
  onNext,
  uploading,
  uploadProgress,
  fileStatuses,
  onRemoveFile,
}: StepDataSourceProps) {
  const hasFiles = files.length > 0;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold text-foreground">上传文档</h3>
        <p className="text-xs text-muted-foreground">
          选择要添加到知识库的文档文件，支持批量上传
        </p>
      </div>

      {/* 拖放区域 */}
      <div className="flex justify-center">
        <FileDropzone
          onFilesSelected={(newFiles) =>
            onFilesChange([...files, ...newFiles])
          }
          disabled={uploading}
        />
      </div>

      {/* 文件列表 */}
      <FileList
        files={files}
        uploadProgress={uploadProgress}
        fileStatuses={fileStatuses}
        onRemove={onRemoveFile}
      />

      {/* 下一步按钮 */}
      <div className="flex justify-end">
        <button
          onClick={onNext}
          disabled={!hasFiles || uploading}
          className="inline-flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          下一步
        </button>
      </div>
    </div>
  );
}
