import { useState } from "react";
import { MessageSquarePlus, Trash2, MessageSquare } from "lucide-react";
import { useConversations, useCreateConversation, useDeleteConversation } from "@/hooks/useApi";
import { useChatStore } from "@/stores/chat";

export function ConversationList() {
    const { data: conversations, isLoading } = useConversations();
    const createConv = useCreateConversation();
    const deleteConv = useDeleteConversation();
    const currentId = useChatStore((s) => s.currentConversationId);
    const setCurrentConversation = useChatStore((s) => s.setCurrentConversation);
    const resetChat = useChatStore((s) => s.resetChat);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

    const handleCreate = async () => {
        const conv = await createConv.mutateAsync();
        setCurrentConversation(conv.id);
        resetChat();
    };

    const handleSelect = (id: string) => {
        setCurrentConversation(id);
        resetChat();
    };

    const handleDelete = (id: string) => {
        if (deleteConfirm === id) {
            deleteConv.mutate(id);
            if (currentId === id) {
                setCurrentConversation(null);
                resetChat();
            }
            setDeleteConfirm(null);
        } else {
            setDeleteConfirm(id);
            setTimeout(() => setDeleteConfirm(null), 3000);
        }
    };

    return (
        <aside className="flex w-64 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40">
            <div className="flex items-center justify-between border-b border-[hsl(var(--border))] p-3">
                <span className="text-sm font-semibold tracking-tight">AgentForge</span>
                <button
                    onClick={handleCreate}
                    disabled={createConv.isPending}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground"
                    title="New Conversation"
                >
                    <MessageSquarePlus className="h-4 w-4" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
                {isLoading && (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                        Loading...
                    </p>
                )}
                {!isLoading && (!conversations || conversations.length === 0) && (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                        No conversations yet
                    </p>
                )}
                {conversations?.map((conv) => (
                    <div
                        key={conv.id}
                        onClick={() => handleSelect(conv.id)}
                        className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${currentId === conv.id
                                ? "bg-[hsl(var(--accent))] font-medium"
                                : "hover:bg-[hsl(var(--accent))]"
                            }`}
                    >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{conv.title}</span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(conv.id);
                            }}
                            className={`ml-auto shrink-0 rounded p-0.5 transition-colors hover:text-red-500 ${deleteConfirm === conv.id
                                    ? "text-red-500 opacity-100"
                                    : "opacity-0 group-hover:opacity-100"
                                }`}
                        >
                            <Trash2 className="h-3 w-3" />
                        </button>
                    </div>
                ))}
            </div>
        </aside>
    );
}
