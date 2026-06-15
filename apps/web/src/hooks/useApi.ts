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
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) =>
      client.createConversation(title ? { title } : undefined),
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

export function useMemories(type?: string) {
  return useQuery({
    queryKey: ["memories", type],
    queryFn: () => client.listMemories(type),
  });
}

export function useSearchMemories(query: string) {
  return useQuery({
    queryKey: ["memories", "search", query],
    queryFn: () => client.searchMemories(query),
    enabled: query.length > 0,
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteMemory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}
