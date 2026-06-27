// LocalStorageProvider — file system backed implementation of StorageProvider.
// Writes under `<project_root>/data/knowledge-files/`.

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { StorageProvider } from "./types.js";

const BASE_DIR = resolvePath(process.cwd(), "data", "knowledge-files");

export class LocalStorageProvider implements StorageProvider {
  /** Resolve a relative path to an absolute path within BASE_DIR. */
  private resolvePath(relativePath: string): string {
    const resolved = resolvePath(BASE_DIR, relativePath);
    // Safety: ensure the resolved path is still under BASE_DIR
    if (!resolved.startsWith(BASE_DIR)) {
      throw new Error(`Invalid storage path: ${relativePath}`);
    }
    return resolved;
  }

  async save(path: string, buffer: Buffer): Promise<string> {
    const fullPath = this.resolvePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);
    return fullPath;
  }

  async read(path: string): Promise<Buffer> {
    const fullPath = this.resolvePath(path);
    return readFile(fullPath);
  }

  async delete(path: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    await unlink(fullPath);
  }

  // 本地存储无法生成公开 URL，返回文件路径（仅供服务端内部使用）
  async getPublicUrl(_path: string, _expiresSec?: number): Promise<string> {
    return `file://${this.resolvePath(_path)}`;
  }
}
