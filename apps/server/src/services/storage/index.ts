import { LocalStorageProvider } from "./local-storage.js";
import { MinioStorageProvider } from "./minio-storage.js";
import { settings } from "../../config.js";
import { logger } from "@agentforge/logger";

export type { StorageProvider } from "./types.js";
export { LocalStorageProvider } from "./local-storage.js";
export { MinioStorageProvider } from "./minio-storage.js";

// Lazy singleton — 根据配置选择 MinIO 或本地存储
let _instance: LocalStorageProvider | MinioStorageProvider | undefined;

export function getStorageProvider(): LocalStorageProvider | MinioStorageProvider {
  if (!_instance) {
    // MinIO 已配置时使用 MinIO，否则降级到本地存储
    if (settings.minioEndpoint && settings.minioAccessKey) {
      try {
        _instance = new MinioStorageProvider();
        logger.info(
          { endpoint: settings.minioEndpoint, bucket: settings.minioBucket },
          "Using MinIO storage provider",
        );
      } catch (e) {
        logger.warn(e, "MinIO init failed, falling back to local storage");
        _instance = new LocalStorageProvider();
      }
    } else {
      _instance = new LocalStorageProvider();
    }
  }
  return _instance;
}
