// 文件拖放区域 —— 支持拖拽 + 点击选择文件，虚线边框 480x200px
import { useCallback, useRef, useState } from "react";
import { Upload, FileText } from "lucide-react";

// ── Props ────────────────────────────────────────

interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  maxSize?: number;
  disabled?: boolean;
}

// ── 格式化文件大小 ────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 组件 ──────────────────────────────────────────

export function FileDropzone({
  onFilesSelected,
  accept = ".pdf,.docx,.txt,.md,.markdown",
  maxSize = 15 * 1024 * 1024, // 15MB
  disabled = false,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (disabled) return;

      const files = Array.from(e.dataTransfer.files);
      const validFiles = files.filter((f) => f.size <= maxSize);
      if (validFiles.length > 0) {
        onFilesSelected(validFiles);
      }
    },
    [disabled, maxSize, onFilesSelected],
  );

  const handleClick = useCallback(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.click();
    }
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        onFilesSelected(files);
      }
      // 重置 input 以允许重复选择同一文件
      if (inputRef.current) inputRef.current.value = "";
    },
    [onFilesSelected],
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={[
        "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-all select-none",
        "w-[480px] h-[200px]",
        isDragging
          ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/5"
          : "border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "cursor-pointer hover:border-[hsl(var(--primary))]/60 hover:bg-[hsl(var(--accent))]",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled}
      />

      <div
        className={[
          "flex items-center justify-center w-10 h-10 rounded-full",
          isDragging
            ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]"
            : "bg-[hsl(var(--muted))] text-muted-foreground",
        ].join(" ")}
      >
        {isDragging ? (
          <FileText className="h-5 w-5" />
        ) : (
          <Upload className="h-5 w-5" />
        )}
      </div>

      <div className="text-center space-y-1">
        {isDragging ? (
          <p className="text-sm font-medium text-[hsl(var(--primary))]">
            松开鼠标放置文件
          </p>
        ) : (
          <>
            <p className="text-sm text-foreground">
              <span className="font-medium text-[hsl(var(--primary))]">
                点击上传
              </span>{" "}
              或拖放文件到此处
            </p>
            <p className="text-xs text-muted-foreground">
              支持 PDF、DOCX、TXT、Markdown 格式
            </p>
            <p className="text-xs text-muted-foreground">
              单个文件最大 {formatSize(maxSize)}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
