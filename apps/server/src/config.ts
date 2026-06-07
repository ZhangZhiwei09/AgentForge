import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

export const settings = {
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5434/agentforge",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  defaultModel: process.env.DEFAULT_MODEL || "gpt-4o-mini",
  debug: process.env.DEBUG === "true",
  milvusHost: process.env.MILVUS_HOST || "localhost",
  milvusPort: process.env.MILVUS_PORT || "19530",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v2",
  port: parseInt(process.env.PORT || "8000", 10),
};
