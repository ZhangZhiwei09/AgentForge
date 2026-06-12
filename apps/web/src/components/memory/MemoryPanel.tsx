import { useState } from "react";
import { useChatStore } from "@/stores/chat";
import { useMemories, useDeleteMemory } from "@/hooks/useApi";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/api";
import {
  Brain,
  Search,
  Trash2,
  Loader2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import type { Memory, MemorySearchResult } from "@/types";

const TYPE_LABELS: Record<string, string> = {
  semantic: "Semantic",
  episodic: "Episodic",
  preference: "Preference",
};

const TYPE_COLORS: Record<string, string> = {
  semantic: "bg-blue-500/10 text-blue-400",
  episodic: "bg-purple-500/10 text-purple-400",
  preference: "bg-amber-500/10 text-amber-400",
};

export function MemoryPanel() {
  const toggleDebugPanel = useChatStore((s) => s.toggleDebugPanel);
  const { data: memories, isLoading, refetch } = useMemories();
  const deleteMemory = useDeleteMemory();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    MemorySearchResult[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const results = await client.searchMemories(searchQuery.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const displayMemories = searchResults ?? memories;

  return (
    <aside className="flex w-72 flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Brain className="h-3.5 w-3.5" />
          Memory Panel
          {memories && memories.length > 0 && (
            <span className="rounded-full bg-[hsl(var(--primary))]/10 px-1.5 py-0.5 text-[10px] text-[hsl(var(--primary))]">
              {memories.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refetch()}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={toggleDebugPanel}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="border-b border-[hsl(var(--border))] px-3 py-2">
        <div className="flex gap-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search memories..."
            className="flex-1 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs text-foreground hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {searching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
          </button>
          {searchResults != null && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchResults(null);
              }}
              className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Memory List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : displayMemories && displayMemories.length > 0 ? (
          <div className="space-y-1.5">
            {displayMemories.map((mem: Memory | MemorySearchResult) => (
              <div
                key={mem.id}
                className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5"
              >
                <div className="mb-1 flex items-center justify-between gap-1">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_COLORS[mem.type] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {TYPE_LABELS[mem.type] ?? mem.type}
                  </span>
                  {"score" in mem && (mem as MemorySearchResult).score > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {(mem as MemorySearchResult).score.toFixed(2)}
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-foreground">
                  {mem.content}
                </p>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    Imp: {mem.importance.toFixed(1)}
                  </span>
                  <button
                    onClick={() => deleteMemory.mutate(mem.id)}
                    disabled={deleteMemory.isPending}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-8 text-center">
            {searchResults != null ? (
              <p className="text-xs text-muted-foreground">
                No matching memories
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  No memories yet.
                </p>
                <div className="rounded border border-dashed border-[hsl(var(--border))] p-3 text-left">
                  <p className="text-[10px] font-medium text-foreground mb-1.5">
                    Quick Start:
                  </p>
                  <code className="block text-[10px] text-muted-foreground leading-relaxed">
                    pnpm db:seed
                  </code>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Or chat with AI and memories will be extracted automatically.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
