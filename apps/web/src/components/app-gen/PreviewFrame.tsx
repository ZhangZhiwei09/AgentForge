import { useEffect, useRef, useState } from "react";
import { useAppProjectStore } from "@/stores/app-project";

export function PreviewFrame() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { files } = useAppProjectStore();
  const [previewMode, setPreviewMode] = useState<"auto" | "html">("auto");

  // Build a previewable HTML from the project files
  useEffect(() => {
    if (files.length === 0) {
      if (iframeRef.current) {
        iframeRef.current.srcdoc = getEmptyPreview();
      }
      return;
    }

    // Try to find an index.html or build a simple preview
    const htmlFile = files.find(
      (f) => f.path === "index.html" || f.path.endsWith("/index.html"),
    );
    const cssFile = files.find((f) => f.path.endsWith(".css"));
    const jsFile = files.find((f) => f.path.endsWith(".js"));
    const tsxFiles = files.filter((f) => f.language === "tsx");

    if (htmlFile) {
      // We have a direct HTML file — use it
      let html = htmlFile.content;
      // Inject CSS if found separately
      if (cssFile && !html.includes(cssFile.path)) {
        html = html.replace(
          "</head>",
          `<style>\n${cssFile.content}\n</style>\n</head>`,
        );
      }
      // Inject JS if found separately
      if (jsFile && !html.includes(jsFile.path)) {
        html = html.replace(
          "</body>",
          `<script>\n${jsFile.content}\n</script>\n</body>`,
        );
      }
      if (iframeRef.current) {
        iframeRef.current.srcdoc = html;
      }
    } else if (tsxFiles.length > 0) {
      // React/Vue app — show a placeholder with the component names
      const appTsx = tsxFiles.find(
        (f) => f.path === "src/App.tsx" || f.path.endsWith("App.tsx"),
      );
      const componentCount = tsxFiles.length;

      const placeholder = getReactPreviewPlaceholder(
        componentCount,
        appTsx?.path || "",
      );
      if (iframeRef.current) {
        iframeRef.current.srcdoc = placeholder;
      }
    } else {
      if (iframeRef.current) {
        iframeRef.current.srcdoc = getEmptyPreview();
      }
    }
  }, [files]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 bg-white">
        <span className="text-xs font-medium text-gray-600">Preview</span>
        <div className="flex items-center gap-2">
          <select
            value={previewMode}
            onChange={(e) => setPreviewMode(e.target.value as any)}
            className="text-xs border border-gray-300 rounded px-1 py-0.5"
          >
            <option value="auto">Auto</option>
            <option value="html">HTML</option>
          </select>
          <button
            onClick={() => {
              // Force refresh the iframe
              const iframe = iframeRef.current;
              if (iframe) {
                const src = iframe.srcdoc;
                iframe.srcdoc = "";
                requestAnimationFrame(() => {
                  iframe.srcdoc = src;
                });
              }
            }}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Preview iframe */}
      <div className="flex-1 relative bg-gray-100 min-h-0">
        <iframe
          ref={iframeRef}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
          title="App Preview"
          srcDoc={getEmptyPreview()}
        />
      </div>
    </div>
  );
}

function getEmptyPreview(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif; background: #f9fafb; color: #6b7280; }
    .empty { text-align: center; }
    .icon { font-size: 48px; margin-bottom: 12px; }
    .text { font-size: 14px; }
  </style>
</head>
<body>
  <div class="empty">
    <div class="icon">🦊</div>
    <div class="text">Your app preview will appear here</div>
    <div style="font-size:12px;margin-top:8px;">Describe your app idea to get started</div>
  </div>
</body>
</html>`;
}

function getReactPreviewPlaceholder(
  componentCount: number,
  mainFile: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif; background: #f0f9ff; color: #1e40af; }
    .card { text-align: center; background: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 12px; }
    .title { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .info { font-size: 13px; color: #6b7280; line-height: 1.5; }
    .badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚛️</div>
    <div class="title">React App Generated</div>
    <div class="info">
      ${componentCount} components generated.<br/>
      Main component: ${mainFile}<br/>
      Live preview requires a build step — coming in Phase 2.
    </div>
    <div class="badge">React + TypeScript</div>
    <div style="margin-top:16px;font-size:11px;color:#9ca3af;">
      Files are ready in the code editor →<br/>
      Use Phase 2 Docker sandbox for live preview
    </div>
  </div>
</body>
</html>`;
}
