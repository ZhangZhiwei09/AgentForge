// tiktoken 为可选依赖（未安装时 embedding-tokenizer 自动降级为启发式估算）
declare module "tiktoken" {
  export function get_encoding(
    name: string,
  ): { encode: (text: string) => number[] };
  export function encoding_for_model(
    model: string,
  ): { encode: (text: string) => number[] };
}
