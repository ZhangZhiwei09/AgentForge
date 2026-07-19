// JSON工具函数 单元测试 — 从LLM响应中提取与解析JSON
import { describe, it, expect } from "vitest";
import { extractJSONFromLLMResponse, parseJSONFromLLMResponse } from "../json-utils.js";

describe("JSON工具函数", () => {
  // =========================================================================
  // extractJSONFromLLMResponse
  // =========================================================================
  describe("extractJSONFromLLMResponse", () => {
    it("从Markdown代码块中提取JSON — ```json 前缀", () => {
      const raw = '```json\n{"name": "test", "value": 42}\n```';
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"name": "test", "value": 42}');
    });

    it("从Markdown代码块中提取JSON — 无json前缀", () => {
      const raw = '```\n{"name": "test", "value": 42}\n```';
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"name": "test", "value": 42}');
    });

    it("从带有前后文本的响应中提取JSON对象", () => {
      const raw = '这是分析结果：\n{"score": 95, "label": "positive"}\n以上仅供参考。';
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"score": 95, "label": "positive"}');
    });

    it("提取JSON数组 — regex仅匹配{}，裸数组会被部分提取", () => {
      const raw = '[{"id": 1}, {"id": 2}, {"id": 3}]';
      const result = extractJSONFromLLMResponse(raw);
      // regex \{[\s\S]*\} 从第一个 { 匹配到最后一个 }，丢失外层 []
      expect(result).toBe('{"id": 1}, {"id": 2}, {"id": 3}');
    });

    it("处理嵌套JSON对象", () => {
      const raw = '{"user": {"name": "Alice", "roles": ["admin"]}}';
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"user": {"name": "Alice", "roles": ["admin"]}}');
    });

    it("处理空字符串输入", () => {
      const result = extractJSONFromLLMResponse("");
      expect(result).toBe("");
    });

    it("处理只有空白字符的输入", () => {
      const result = extractJSONFromLLMResponse("   \n\t  ");
      expect(result).toBe("");
    });

    it("不包含JSON对象的文本返回原文本trim后结果", () => {
      const raw = "这只是一段普通文本，不包含任何JSON结构。";
      const result = extractJSONFromLLMResponse(raw);
      // 没有 {} 匹配，返回 trim 后的原始文本
      expect(result).toBe(raw);
    });

    it("提取Markdown代码块中的JSON数组", () => {
      const raw = '```json\n[1, 2, 3, 4, 5]\n```';
      const result = extractJSONFromLLMResponse(raw);
      // regex只匹配 {}，数组没有 {}，会 fallback 到 parts[1] trim
      expect(result).toBe("[1, 2, 3, 4, 5]");
    });

    it("处理Markdown代码块内有json前缀但无内容的边缘情况", () => {
      const raw = "```json\n\n```";
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe("");
    });

    it("每个代码块分隔符都会切割 — 取第一个非空内容块", () => {
      // parts[0]="", parts[1]="{...}", parts[2]="..."
      const raw = '```\n{"a": 1}\n```\n额外说明';
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"a": 1}');
    });

    it("处理只有开始反引号没有结束的情况(非标准Markdown)", () => {
      const raw = '```\n{"key": "val"}';
      // parts = ['', '\n{"key": "val"}'] → parts[1] = '\n{"key": "val"}'
      const result = extractJSONFromLLMResponse(raw);
      expect(result).toBe('{"key": "val"}');
    });
  });

  // =========================================================================
  // parseJSONFromLLMResponse
  // =========================================================================
  describe("parseJSONFromLLMResponse", () => {
    it("从Markdown代码块中解析JSON对象", () => {
      const raw = '```json\n{"status": "ok", "count": 10}\n```';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ status: "ok", count: 10 });
    });

    it("从无代码块的纯文本中解析JSON", () => {
      const raw = '{"name": "AgentForge", "version": "1.0"}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ name: "AgentForge", version: "1.0" });
    });

    it("不包含JSON的文本返回null", () => {
      const raw = "这是给用户的一段友好回复，不包含任何结构化数据。";
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toBeNull();
    });

    it("处理JSON中的尾部逗号 — JSON.parse无法解析，返回null", () => {
      const raw = '{"name": "test", "value": 42,}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toBeNull();
    });

    it("解析嵌套JSON对象", () => {
      const raw = '{"config": {"debug": true, "logLevel": "info", "targets": ["web", "api"]}}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({
        config: {
          debug: true,
          logLevel: "info",
          targets: ["web", "api"],
        },
      });
    });

    it("解析JSON数组", () => {
      const raw = '{"items": [{"id": 1}, {"id": 2}]}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    });

    it("解析纯JSON数组（顶层数组） — regex仅匹配{}，数组经提取后非法JSON → null", () => {
      const raw = '[{"action": "move"}, {"action": "stop"}]';
      const result = parseJSONFromLLMResponse(raw);
      // extractJSONFromLLMResponse 的 regex 只匹配 {}，会丢失外层 []
      // 提取结果为 '{"action": "move"}, {"action": "stop"}'，不是合法 JSON
      expect(result).toBeNull();
    });

    it("返回unknown类型 — 可赋给任意对象形状", () => {
      // 类型层面验证：parseJSONFromLLMResponse 返回 unknown
      const raw = '{"token": "abc123", "expires_in": 3600}';
      const result: unknown = parseJSONFromLLMResponse(raw);
      // 需要类型断言才能访问属性（符合 unknown 语义）
      const obj = result as { token: string; expires_in: number };
      expect(obj.token).toBe("abc123");
      expect(obj.expires_in).toBe(3600);
    });

    // --- Safe JSON parse 语义 ---
    it("有效JSON字符串返回已解析对象", () => {
      const raw = '{"key": "value"}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).not.toBeNull();
      expect(result).toEqual({ key: "value" });
    });

    it("无效JSON字符串返回null", () => {
      const raw = "{invalid json content!}";
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toBeNull();
    });

    it("空字符串返回null", () => {
      const result = parseJSONFromLLMResponse("");
      expect(result).toBeNull();
    });

    it("前导反引号包裹导致的正则匹配失败 — 返回null", () => {
      // 单独的反引号不会触发 startsWith("```") 分支
      // 该字符串不含 {}，最终 clean 不是合法 JSON → null
      const raw = '`not json`';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toBeNull();
    });

    it("JSON字符串包含Unicode转义 — 正常解析", () => {
      const raw = '{"greeting": "\\u4f60\\u597d"}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ greeting: "你好" });
    });

    it("JSON中的布尔值和null字面量 — 保持原样", () => {
      const raw = '{"active": true, "deleted": false, "meta": null}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ active: true, deleted: false, meta: null });
    });

    it("JSON中的数字类型 — 整数与浮点数", () => {
      const raw = '{"integer": 42, "float": 3.14, "negative": -10, "scientific": 1.5e10}';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ integer: 42, float: 3.14, negative: -10, scientific: 1.5e10 });
    });

    it("Markdown代码块中有json前缀且含嵌套JSON", () => {
      const raw =
        '```json\n{"tool": "search", "params": {"query": "hello", "limit": 5}}\n```';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({
        tool: "search",
        params: { query: "hello", limit: 5 },
      });
    });

    it("前后文本+Markdown代码块混合场景", () => {
      const raw =
        'AI分析完成，结果如下：\n```json\n{"confidence": 0.95, "label": "safe"}\n```\n请根据结果进一步处理。';
      const result = parseJSONFromLLMResponse(raw);
      expect(result).toEqual({ confidence: 0.95, label: "safe" });
    });
  });
});
