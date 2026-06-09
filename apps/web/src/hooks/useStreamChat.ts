import { useState, useCallback, useRef } from "react";
import type { ChatStreamChunk, Message } from "@agentforge/shared-types";
import { useChatStore } from "@/stores/chat";
import { client } from "@/lib/api";

export function useStreamChat() {
    const [isLoading, setIsLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const {
        currentConversationId,
        selectedModel,
        enabledTools,
        appendMessage,
        appendStreamToken,
        setDebugInfo,
        setMemoryInfo,
        setIsStreaming,
        addToolCall,
        setToolResult,
    } = useChatStore();

    const sendMessage = useCallback(
        async (content: string) => {
            if (!currentConversationId) return;
            setIsLoading(true);
            setIsStreaming(true);

            const userMsg: Message = {
                id: `user-${Date.now()}`,
                conversation_id: currentConversationId,
                role: "user",
                content,
                model: selectedModel,
                created_at: new Date().toISOString(),
            };
            appendMessage(userMsg);

            const assistantMsg: Message = {
                id: "__streaming__",
                conversation_id: currentConversationId,
                role: "assistant",
                content: "",
                model: selectedModel,
                created_at: new Date().toISOString(),
            };
            appendMessage(assistantMsg);

            try {
                let metaInfo: Partial<ChatStreamChunk> = {};

                for await (const chunk of client.streamChat({
                    conversation_id: currentConversationId,
                    message: content,
                    model: selectedModel,
                    tools: enabledTools.length > 0 ? enabledTools : null,
                })) {
                    if (chunk.type === "meta") {
                        metaInfo = chunk;
                    } else if (chunk.type === "token" && chunk.content) {
                        appendStreamToken(chunk.content);
                    } else if (chunk.type === "tool_call" && chunk.tool_call) {
                        addToolCall({
                            id: chunk.tool_call.id,
                            name: chunk.tool_call.name,
                            arguments: chunk.tool_call.arguments,
                        });
                    } else if (chunk.type === "tool_result" && chunk.tool_result) {
                        setToolResult(chunk.tool_result.tool_call_id, chunk.tool_result.result);
                    } else if (chunk.type === "done") {
                        setDebugInfo({
                            model: (metaInfo.model || chunk.model || selectedModel) ?? "",
                            provider: (metaInfo.provider ?? "unknown") as string,
                            system_prompt: "",
                            prompt_tokens: chunk.usage?.prompt_tokens ?? 0,
                            completion_tokens: chunk.usage?.completion_tokens ?? 0,
                            total_tokens: chunk.usage?.total_tokens ?? 0,
                            latency_ms: (chunk.usage as any)?.latency_ms ?? 0,
                            first_token_ms: (chunk.usage as any)?.first_token_ms ?? 0,
                            temperature: 0.7,
                            max_tokens: 4096,
                        });
                        if ((chunk as any).memory) {
                            setMemoryInfo((chunk as any).memory);
                        }
                    } else if (chunk.type === "error") {
                        console.error("Stream error:", chunk.content);
                    }
                }
            } catch (err) {
                console.error("Chat stream failed:", err);
            } finally {
                setIsLoading(false);
                setIsStreaming(false);
            }
        },
        [currentConversationId, selectedModel, enabledTools, appendMessage, appendStreamToken, setDebugInfo, setMemoryInfo, setIsStreaming, addToolCall, setToolResult]
    );

    const abort = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    return { sendMessage, isLoading, abort };
}
