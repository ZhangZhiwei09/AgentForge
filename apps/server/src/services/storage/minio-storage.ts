// MinIO Storage Provider —— 对象存储实现
// 继承 StorageProvider 接口，替换本地文件系统为 MinIO/S3 兼容存储
// 降级策略：MinIO 不可用时 getStorageProvider() 自动回退到 LocalStorageProvider
import { Client as MinioClient } from "minio";
import { settings } from "../../config.js";
import { logger } from "@agentforge/logger";
import type { StorageProvider } from "./types.js";

export class MinioStorageProvider implements StorageProvider {
  private client: MinioClient | null = null;
  private bucket: string;

  constructor() {
    this.bucket = settings.minioBucket;
  }

  private getClient(): MinioClient {
    if (!this.client) {
      this.client = new MinioClient({
        endPoint: settings.minioEndpoint,
        port: settings.minioPort,
        useSSL: settings.minioUseSSL,
        accessKey: settings.minioAccessKey,
        secretKey: settings.minioSecretKey,
      });
    }
    return this.client;
  }

  // 确保 bucket 存在（幂等）
  private async ensureBucket(): Promise<void> {
    const client = this.getClient();
    const exists = await client.bucketExists(this.bucket);
    if (!exists) {
      await client.makeBucket(this.bucket);
      logger.info({ bucket: this.bucket }, "MinIO bucket created");
    }
  }

  // 保存文件到 MinIO，返回存储 key（用于后续读取）
  async save(path: string, buffer: Buffer): Promise<string> {
    await this.ensureBucket();
    const client = this.getClient();

    // 使用 path 作为 object key（去掉前导斜杠和 ..）
    const objectKey = path.replace(/^\/+/, "").replace(/\.\./g, "");

    await client.putObject(this.bucket, objectKey, buffer, buffer.length);
    logger.info({ bucket: this.bucket, key: objectKey }, "File saved to MinIO");
    return objectKey;
  }

  // 从 MinIO 读取文件
  async read(path: string): Promise<Buffer> {
    const objectKey = path.replace(/^\/+/, "").replace(/\.\./g, "");
    const client = this.getClient();

    try {
      const stream = await client.getObject(this.bucket, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      logger.error({ bucket: this.bucket, key: objectKey, error: String(e) }, "MinIO read failed");
      throw e;
    }
  }

  // 从 MinIO 删除文件
  async delete(path: string): Promise<void> {
    const objectKey = path.replace(/^\/+/, "").replace(/\.\./g, "");
    const client = this.getClient();

    try {
      await client.removeObject(this.bucket, objectKey);
      logger.info({ bucket: this.bucket, key: objectKey }, "File deleted from MinIO");
    } catch (e) {
      logger.warn({ bucket: this.bucket, key: objectKey, error: String(e) }, "MinIO delete failed");
    }
  }

  // 生成公开访问 URL（签名 URL，默认 24 小时有效）
  async getPublicUrl(path: string, expiresSec: number = 86400): Promise<string> {
    const objectKey = path.replace(/^\/+/, "").replace(/\.\./g, "");
    const client = this.getClient();

    try {
      // 生成 presigned GET URL
      const url = await client.presignedGetObject(
        this.bucket,
        objectKey,
        expiresSec,
      );
      return url;
    } catch {
      // 签名 URL 生成失败，返回拼接的内部 URL（不一定能公网访问）
      const port = settings.minioPort;
      const ssl = settings.minioUseSSL;
      const protocol = ssl ? "https" : "http";
      return `${protocol}://${settings.minioEndpoint}:${port}/${this.bucket}/${objectKey}`;
    }
  }
}
