-- Drop tables for removed features: Voice, Video, Knowledge Graph
-- CASCADE handles foreign key constraints from voice_sessions/video_sessions → conversations
DROP TABLE IF EXISTS "video_sessions" CASCADE;
DROP TABLE IF EXISTS "voice_sessions" CASCADE;
DROP TABLE IF EXISTS "knowledge_graph_relations";
DROP TABLE IF EXISTS "knowledge_graph_entities";
