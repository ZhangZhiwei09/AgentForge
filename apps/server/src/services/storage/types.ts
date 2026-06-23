// StorageProvider interface — abstracts file system operations
// so the ingestion pipeline is not coupled to local disk.
// Future: swap in MinIO/S3 implementation.

export interface StorageProvider {
  /** Persist a file. Returns the path or URI that can be used to retrieve it. */
  save(path: string, buffer: Buffer): Promise<string>;

  /** Read a file back from storage. */
  read(path: string): Promise<Buffer>;

  /** Delete a file from storage. */
  delete(path: string): Promise<void>;
}
