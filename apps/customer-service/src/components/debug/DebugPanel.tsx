import { useChatStore } from "@/stores/chat";
import {
  PanelRightClose,
  Cpu,
  Braces,
  Timer,
  Gauge,
  Brain,
  Wrench,
  Check,
  Loader2,
} from "lucide-react";
import { DiagnosisSection } from "./DiagnosisSection";

export function DebugPanel() {
  const debugInfo = useChatStore((s) => s.debugInfo);
  const memoryInfo = useChatStore((s) => s.memoryInfo);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const toggleDebugPanel = useChatStore((s) => s.toggleDebugPanel);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const toolCalls = useChatStore((s) => s.toolCalls);

  return (
    <aside className="flex w-72 flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Braces className="h-3.5 w-3.5" />
          Debug Panel
        </div>
        <button
          onClick={toggleDebugPanel}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-4">
          <Section label="Model" icon={<Cpu className="h-3.5 w-3.5" />}>
            <InfoRow label="Model" value={debugInfo?.model ?? selectedModel} />
            <InfoRow label="Provider" value={debugInfo?.provider ?? "-"} />
            <InfoRow
              label="Status"
              value={isStreaming ? "🟢 Streaming" : "⚪ Idle"}
            />
          </Section>

          <Section label="Tokens" icon={<Gauge className="h-3.5 w-3.5" />}>
            <InfoRow
              label="Prompt"
              value={debugInfo ? String(debugInfo.prompt_tokens) : "-"}
            />
            <InfoRow
              label="Completion"
              value={debugInfo ? String(debugInfo.completion_tokens) : "-"}
            />
            <InfoRow
              label="Total"
              value={debugInfo ? String(debugInfo.total_tokens) : "-"}
            />
          </Section>

          <Section label="Latency" icon={<Timer className="h-3.5 w-3.5" />}>
            <InfoRow
              label="First Token"
              value={
                debugInfo?.first_token_ms != null
                  ? `${debugInfo.first_token_ms}ms`
                  : "-"
              }
            />
            <InfoRow
              label="Total"
              value={
                debugInfo?.latency_ms != null
                  ? `${debugInfo.latency_ms}ms`
                  : "-"
              }
            />
          </Section>

          {memoryInfo && (
            <Section label="Memory" icon={<Brain className="h-3.5 w-3.5" />}>
              <InfoRow label="Injected" value={String(memoryInfo.injected)} />
              <InfoRow label="Extracted" value={String(memoryInfo.extracted)} />
            </Section>
          )}

          {toolCalls.length > 0 && (
            <Section label="Tools" icon={<Wrench className="h-3.5 w-3.5" />}>
              {toolCalls.map((tc) => (
                <div key={tc.id} className="space-y-1 py-1">
                  <div className="flex items-center gap-1.5">
                    {tc.status === "pending" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                    ) : (
                      <Check className="h-3 w-3 text-green-500" />
                    )}
                    <span className="text-xs font-medium">
                      {tc.name
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground pl-4">
                    {(() => {
                      try {
                        const args = JSON.parse(tc.arguments);
                        return Object.entries(args)
                          .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
                          .join(" ");
                      } catch {
                        return tc.arguments.slice(0, 60);
                      }
                    })()}
                  </div>
                  {tc.result && (
                    <div className="text-[10px] font-mono text-muted-foreground pl-4 break-all">
                      → {tc.result.slice(0, 80)}
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}

          <Section label="Parameters" icon={<Braces className="h-3.5 w-3.5" />}>
            <InfoRow
              label="Temperature"
              value={debugInfo ? String(debugInfo.temperature) : "-"}
            />
            <InfoRow
              label="Max Tokens"
              value={debugInfo ? String(debugInfo.max_tokens) : "-"}
            />
          </Section>

          {/* Multi-Agent Diagnosis Test */}
          <DiagnosisSection />
        </div>
      </div>
    </aside>
  );
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <div className="flex items-center gap-1.5 border-b border-[hsl(var(--border))] px-3 py-2 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="space-y-1.5 px-3 py-2">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
