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
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5434/agentforge",
  // OpenAI API 配置（用于 LLM 对话 + Embedding）
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  // DeepSeek API 配置（性价比更高的备选 LLM）
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  // 默认使用的模型 ID，会从所有 provider 的模型列表中匹配
  defaultModel: process.env.DEFAULT_MODEL || "gpt-4o-mini",
  debug: process.env.DEBUG === "true",
  // Milvus 向量数据库地址（用于记忆搜索和知识库检索）
  milvusHost: process.env.MILVUS_HOST || "localhost",
  milvusPort: process.env.MILVUS_PORT || "19530",
  // Embedding 模型名称
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v2",
  port: parseInt(process.env.PORT || "8000", 10),
};
