-- AlterTable: Add runtime_state column for LangGraph durable checkpoint storage.
-- Per langchain-langgraph-refactor-plan.md §10.4:
--   runtime_state stores serialized LangGraph CheckpointTuple blob
--   (channel_values, channel_versions, pending_sends, checkpoint_id, etc.)
--   plus engine metadata (engine type, version, created_at).
-- Legacy sessions have NULL runtime_state.
ALTER TABLE "agent_sessions" ADD COLUMN "runtime_state" JSONB;
