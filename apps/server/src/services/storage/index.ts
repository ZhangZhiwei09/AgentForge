import { LocalStorageProvider } from "./local-storage.js";

export type { StorageProvider } from "./types.js";
export { LocalStorageProvider } from "./local-storage.js";

// Lazy singleton — create on first access
let _instance: LocalStorageProvider | undefined;

export function getStorageProvider(): LocalStorageProvider {
  if (!_instance) {
    _instance = new LocalStorageProvider();
  }
  return _instance;
}
