// 配置模块 —— 从 .env 文件加载所有环境变量，统一导出为 settings 对象
// 每个配置项都有合理的默认值，本地开发无需 .env 文件也能启动
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// CJS 打包时 __dirname 为全局变量；ESM 开发时用 import.meta.url
declare var __dirname: string | undefined;
const cwd = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

// 加载 apps/server/.env 文件，优先级高于系统环境变量
config({ path: resolve(cwd, "../.env") });

export const settings = {
  // PostgreSQL 连接字符串，端口 5434 避免和本地其他 PG 实例冲突
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5434/agentforge",
  // OpenAI API 配置（用于 LLM 对话 + Embedding）
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  // DeepSeek API 配置（性价比更高的备选 LLM）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl:
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  // 默认使用的模型 ID，会从所有 provider 的模型列表中匹配
  defaultModel: process.env.DEFAULT_MODEL || "gpt-4o-mini",
  // TASK 内部意图分类模型（轻量，默认跟随 defaultModel）
  taskIntentModel: process.env.TASK_INTENT_MODEL || process.env.DEFAULT_MODEL || "gpt-4o-mini",
  // simple_qa 快速路径模型（可配置更廉价模型降低延迟，留空跟随 defaultModel）
  simpleQaModel: process.env.SIMPLE_QA_MODEL || process.env.DEFAULT_MODEL || "gpt-4o-mini",
  corsOrigins: process.env.CORS_ORIGINS || "",
  debug: process.env.DEBUG === "true",
  // Milvus 向量数据库地址（用于记忆搜索和知识库检索）
  milvusHost: process.env.MILVUS_HOST || "localhost",
  milvusPort: process.env.MILVUS_PORT || "19530",
  // Embedding 模型名称
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v2",
  // Embedding API 独立端点（默认跟随 OPENAI_BASE_URL）
  // 当 LLM 用 DeepSeek 但 Embedding 用 DashScope/OpenAI 时需单独配置
  embeddingBaseUrl:
    process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  embeddingApiKey:
    process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "",
  port: parseInt(process.env.PORT || "8000", 10),
  // Redis 连接 URL（可选，用于限流存储等场景）
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  // 代码执行沙箱配置（Docker 容器中执行 Python/JavaScript）
  sandboxImage: process.env.SANDBOX_IMAGE || "agentforge-sandbox:latest",
  sandboxTimeoutSec: parseInt(process.env.SANDBOX_TIMEOUT_SEC || "60", 10),
  sandboxMemoryMb: parseInt(process.env.SANDBOX_MEMORY_MB || "256", 10),
  sandboxCpuShares: parseInt(process.env.SANDBOX_CPU_SHARES || "512", 10), // 0.5 CPU
  // 语音 Agent (V5) — 复用 openaiApiKey，无需额外密钥
  voiceEnabled: process.env.VOICE_ENABLED !== "false",
  asrModel: process.env.ASR_MODEL || "whisper-1",
  ttsModel: process.env.TTS_MODEL || "tts-1",
  ttsVoice: process.env.TTS_VOICE || "alloy",
  ttsSpeed: parseFloat(process.env.TTS_SPEED || "1.0"),
  // 视频对话 Agent (V11) — 复用 openaiApiKey，使用 GPT-4o 等多模态模型
  videoEnabled: process.env.VIDEO_ENABLED !== "false",
  videoModel: process.env.VIDEO_MODEL || "gpt-4o-mini",
  videoVisionFps: parseInt(process.env.VIDEO_VISION_FPS || "1", 10),
  // Langfuse LLM Observability（自托管）
  langfuseEnabled: process.env.LANGFUSE_ENABLED !== "false",
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || "http://localhost:3000",
  langfusePublicKey:
    process.env.LANGFUSE_PUBLIC_KEY || "pk-not-used-selfhosted",
  langfuseSecretKey:
    process.env.LANGFUSE_SECRET_KEY || "sk-not-used-selfhosted",

  // ── PGVector ─────────────────────────────────────────
  pgvectorEnabled: process.env.PGVECTOR_ENABLED !== "false",

  // ── Ollama 本地 Embedding ───────────────────────────
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3",

  // ── Elasticsearch ────────────────────────────────────
  elasticsearchUrl: process.env.ELASTICSEARCH_URL || "http://localhost:9200",

  // ── Reranker ─────────────────────────────────────────
  rerankerBaseUrl: process.env.RERANKER_BASE_URL || "",
  rerankerModel: process.env.RERANKER_MODEL || "",

  // ── Neo4j ────────────────────────────────────────────
  neo4jUri: process.env.NEO4J_URI || "bolt://localhost:7687",
  neo4jUser: process.env.NEO4J_USER || "neo4j",
  neo4jPassword: process.env.NEO4J_PASSWORD || "agentforge123",

  // ── MinIO ────────────────────────────────────────────
  minioEndpoint: process.env.MINIO_ENDPOINT || "localhost",
  minioPort: parseInt(process.env.MINIO_PORT || "9000", 10),
  minioAccessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  minioSecretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
  minioBucket: process.env.MINIO_BUCKET || "agentforge-docs",
  minioUseSSL: process.env.MINIO_USE_SSL === "true",

  // ── Mem0 ─────────────────────────────────────────────
  mem0ApiKey: process.env.MEM0_API_KEY || "",
  mem0BaseUrl: process.env.MEM0_BASE_URL || "",
};
