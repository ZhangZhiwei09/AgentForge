export type MemoryType = "episodic" | "semantic" | "preference";

export interface Memory {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  importance: number;
  metadata?: Record<string, unknown>;
  conversation_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult extends Memory {
  score: number;
}

export interface MemoryInfo {
  injected: number;
  extracted: number;
}
