// 配置模块 —— 从 .env 文件加载所有环境变量，统一导出为 settings 对象
// 每个配置项都有合理的默认值，本地开发无需 .env 文件也能启动
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ESM 模块中获取 __dirname 的等价写法
const __dirname = dirname(fileURLToPath(import.meta.url));
// 加载 apps/server/.env 文件，优先级高于系统环境变量
config({ path: resolve(__dirname, "../.env") });

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
  debug: process.env.DEBUG === "true",
  // Milvus 向量数据库地址（用于记忆搜索和知识库检索）
  milvusHost: process.env.MILVUS_HOST || "localhost",
  milvusPort: process.env.MILVUS_PORT || "19530",
  // Embedding 模型名称
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v2",
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
};
