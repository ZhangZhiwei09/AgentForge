import { useProviders } from "@/hooks/useApi";
import { useChatStore } from "@/stores/chat";

export function ModelSelector() {
  const { data: providers, isLoading } = useProviders();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedProvider = useChatStore((s) => s.selectedProvider);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const setSelectedProvider = useChatStore((s) => s.setSelectedProvider);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const allModels =
    providers?.flatMap((p) =>
      p.models.map((m) => ({ ...m, provider: p.type })),
    ) ?? [];

  return (
    <select
      value={selectedModel}
      onChange={(e) => {
        const model = allModels.find((m) => m.id === e.target.value);
        setSelectedModel(e.target.value);
        if (model) setSelectedProvider(model.provider as any);
      }}
      disabled={isStreaming || isLoading}
      className="rounded-lg border border-[hsl(var(--border))] bg-transparent px-3 py-1.5 text-xs outline-none transition-colors focus:border-foreground/30"
    >
      {isLoading && <option>Loading models...</option>}
      {allModels.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({m.provider})
        </option>
      ))}
    </select>
  );
}
