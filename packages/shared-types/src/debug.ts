export interface DebugInfo {
  model: string;
  provider: string;
  system_prompt: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  first_token_ms: number;
  temperature: number;
  max_tokens: number;
}

export interface DebugPanelProps {
  debugInfo: DebugInfo | null;
  isStreaming: boolean;
}
