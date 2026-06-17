import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/api";

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
