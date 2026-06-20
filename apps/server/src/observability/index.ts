// Observability 生命周期管理 —— 收口所有观测后端
//
// 设计要点：
// - getObservabilityProvider() 永远返回合法对象（启用=Langfuse, 禁用=Noop）
// - Provider 完全留在启动层，不进 ExecutionScope
// - 业务代码不 import 此文件 —— 只 import { ObservabilityTrace } from "./provider.js"

import { LangfuseProvider } from "./langfuse-provider.js";
import {
  NoopProvider,
  type ObservabilityProvider,
} from "./provider.js";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

let provider: ObservabilityProvider = new NoopProvider();

/** 初始化所有观测后端（启动时调用一次） */
export function initObservability(): void {
  if (!settings.langfuseEnabled) {
    logger.info("Observability disabled — using NoopProvider");
    return;
  }

  try {
    provider = new LangfuseProvider({
      baseUrl: settings.langfuseBaseUrl,
      publicKey: settings.langfusePublicKey,
      secretKey: settings.langfuseSecretKey,
    });
    logger.info(
      { name: provider.name, baseUrl: settings.langfuseBaseUrl },
      "Observability provider initialized",
    );
  } catch (err) {
    logger.warn(err, "Failed to initialize Langfuse — using NoopProvider");
    provider = new NoopProvider();
  }
}

/** 获取观测 Provider —— 永远返回合法对象，不返回 null */
export function getObservabilityProvider(): ObservabilityProvider {
  return provider;
}

/** 优雅关闭所有观测后端（SIGTERM/SIGINT 时调用） */
export async function shutdownObservability(): Promise<void> {
  try {
    await provider.shutdown();
    logger.info("Observability shutdown complete");
  } catch (err) {
    logger.warn(err, "Observability shutdown failed");
  }
}
