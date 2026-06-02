import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/api";

export function useConversations() {
    return useQuery({
        queryKey: ["conversations"],
        queryFn: () => client.listConversations(),
    });
}

export function useMessages(conversationId: string | null) {
    return useQuery({
        queryKey: ["messages", conversationId],
        queryFn: () => client.getMessages(conversationId!),
        enabled: !!conversationId,
    });
}

export function useCreateConversation() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (title?: string) => client.createConversation(title ? { title } : undefined),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    });
}

export function useDeleteConversation() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => client.deleteConversation(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    });
}

export function useProviders() {
    return useQuery({
        queryKey: ["providers"],
        queryFn: () => client.listProviders(),
        staleTime: 600000,
    });
}
