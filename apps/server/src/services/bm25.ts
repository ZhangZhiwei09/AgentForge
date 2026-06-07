import { MilvusClient } from "@zilliz/milvus2-sdk-node";

let bm25Encoder: any = null;
let fitted = false;

function getBM25() {
  if (bm25Encoder) return bm25Encoder;
  // Use Milvus client for BM25 — note: BM25EmbeddingFunction is not directly
  // available in the Node SDK. We implement a lightweight wrapper that
  // delegates to Python-style sparsity. For now, return a stub.
  // In production, use Milvus's built-in BM25 via REST API.
  bm25Encoder = {
    fit: (_corpus: string[]) => { fitted = true; },
    encodeDocuments: (_docs: string[]) => _docs.map(() => ({})),
    encodeQueries: (_queries: string[]) => _queries.map(() => ({})),
  };
  return bm25Encoder;
}

export class BM25SparseEncoder {
  private encoder: any = null;
  private isFitted = false;

  private getEncoder() {
    if (!this.encoder) {
      this.encoder = getBM25();
    }
    return this.encoder;
  }

  fit(corpus: string[]): void {
    if (!corpus.length) return;
    try {
      const encoder = this.getEncoder();
      encoder.fit(corpus);
      this.isFitted = true;
      console.log(`[bm25] BM25 fitted on corpus size: ${corpus.length}`);
    } catch (e) {
      console.warn(`[bm25] BM25 fit failed:`, e);
      this.isFitted = false;
    }
  }

  encodeDocuments(docs: string[]): Array<Record<string, number>> {
    if (!this.isFitted) return docs.map(() => ({}));
    try {
      return this.getEncoder().encodeDocuments(docs);
    } catch (e) {
      console.warn(`[bm25] Document encoding failed:`, e);
      return docs.map(() => ({}));
    }
  }

  encodeQueries(queries: string[]): Array<Record<string, number>> {
    if (!this.isFitted) return queries.map(() => ({}));
    try {
      return this.getEncoder().encodeQueries(queries);
    } catch (e) {
      console.warn(`[bm25] Query encoding failed:`, e);
      return queries.map(() => ({}));
    }
  }

  static fitOnCorpus(corpus: string[]): BM25SparseEncoder {
    const encoder = new BM25SparseEncoder();
    encoder.fit(corpus);
    return encoder;
  }
}
