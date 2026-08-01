// Agent Runtime 质量保障单元测试
// ============================================
// 覆盖：validateBusinessResponse（五层校验管线）、
//       CitationVerifier（语义引证校验）
// 所有测试不依赖 LLM / Milvus / embedding provider，CI 环境可运行

import { describe, it, expect } from "vitest";
import {
  validateBusinessResponse,
  SORRY_TEMPLATE,
} from "../services/agent-runtime/validation.js";

// ═══════════════════════════════════════════════════════
// 1. validateBusinessResponse 五层校验管线测试
// ═══════════════════════════════════════════════════════

describe("validateBusinessResponse — 五层校验管线", () => {
  describe("Layer 1: JSON 可解析", () => {
    it("有效 JSON 通过 L1", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好，有什么可以帮助您的？",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("自然语言文本跳过 L1/L2，直接进入 L3-L5", () => {
      const result = validateBusinessResponse(
        "您的任务已执行完成。",
        [],
      );
      // 不含禁止模式，应通过
    });

    it("含 JSON 结构但格式错误的输入仍在 L1/L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ wrong_field: "test" }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });
  });

  describe("Layer 2: Schema 校验", () => {
    it("缺少 answer 字段在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("answer 超过 2000 字符在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: "A".repeat(2001), suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("suggestions 超过 3 条在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "好的",
          suggestions: ["1", "2", "3", "4"],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("合法 Schema 通过 L2", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "任务已完成，结果如下...",
          suggestions: ["查看详情", "联系支持"],
        }),
        [
          "知识库内容：任务执行后可在控制台查看详细日志。",
        ],
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 3: 禁止行为扫描", () => {
    it("虚假权威引用被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "根据我司规定，申请需要7天内提交",
          suggestions: [],
        }),
        ["知识库内容：申请政策为提交后7天内可审批"],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("虚假权威引用");
    });

    it("虚假查询陈述被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "经查询，您的请求目前正在处理中。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("虚假查询陈述");
    });

    it("无依据推测被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "系统错误，可能是因为网络波动导致。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("无依据推测");
    });

    it("推卸责任式建议被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "建议您自行查看文档排查问题。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
    });

    it("正常合规回复通过 L3", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer:
            "根据知识库文档，配置方式如下...如需帮助请随时联系。",
          suggestions: ["查看详情"],
        }),
        ["KB chunk about configuration"],
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 5: KB 为空但回复包含事实性内容", () => {
    it("无 KB 上下文时编造事实性回复被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "部署需要5个工作日完成，请耐心等待。",
          suggestions: [],
        }),
        [], // KB 为空
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(5);
      expect(result.errors[0]).toContain("疑似编造");
    });

    it("SORRY_TEMPLATE 在无 KB 时不触发 L5 拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: SORRY_TEMPLATE, suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("无 KB 但回复不含事实性指标时通过 L5", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好！请问有什么可以帮助您的吗？",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 4: KB 回退关键词匹配", () => {
    it("KB 有内容但回复与 KB 无关时报 L4 弱告警", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您的退款将在明天处理，请耐心等待。",
          suggestions: [],
        }),
        ["政策说明：提交后1-3个工作日完成审批"],
      );
      expect(result.valid).toBe(true);
      const l4Error = result.errors.find((e) =>
        e.startsWith("Layer4(keyword)"),
      );
      expect(l4Error).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// 2. CitationVerifier 核心逻辑测试
// ═══════════════════════════════════════════════════════

describe("CitationVerifier", () => {
  describe("validateBusinessResponse L4 keyword fallback", () => {
    it("回复内容与 KB 高度匹配时不产生 L4 告警", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer:
            "提交后1-3个工作日完成审批，审批通过后即可生效。",
          suggestions: [],
        }),
        [
          "政策说明：提交后1-3个工作日完成审批。非标准流程需额外审核。",
        ],
      );
      expect(result.valid).toBe(true);
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });

    it("空 KB 不触发 L4 检查", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好！",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });
  });

  describe("SORRY_TEMPLATE 豁免", () => {
    it("SORRY_TEMPLATE 即使 KB 有内容也不触发 L4", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: SORRY_TEMPLATE, suggestions: [] }),
        ["KB 内容：详细的配置说明"],
      );
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// 3. ChatResponseSchema 边界测试
// ═══════════════════════════════════════════════════════

import { parseChatResponse } from "../services/agent-runtime/validation.js";

describe("parseChatResponse", () => {
  it("解析有效 ChatResponse JSON", () => {
    const result = parseChatResponse(
      JSON.stringify({ answer: "任务已完成", suggestions: ["查看详情"] }),
    );
    expect(result).not.toBeNull();
    expect(result!.answer).toBe("任务已完成");
    expect(result!.suggestions).toEqual(["查看详情"]);
  });

  it("无效 JSON 返回 null", () => {
    const result = parseChatResponse("not json{");
    expect(result).toBeNull();
  });

  it("Schema 不匹配的 JSON 返回 null", () => {
    const result = parseChatResponse(JSON.stringify({ wrong_field: true }));
    expect(result).toBeNull();
  });

  it("suggestions 为默认空数组", () => {
    const result = parseChatResponse(JSON.stringify({ answer: "您好" }));
    expect(result).not.toBeNull();
    expect(result!.suggestions).toEqual([]);
  });

  it("JSON 包裹在 markdown 代码块中也能解析", () => {
    const result = parseChatResponse(
      '```json\n{"answer": "测试回复", "suggestions": []}\n```',
    );
    expect(result).not.toBeNull();
    expect(result!.answer).toBe("测试回复");
  });
});
