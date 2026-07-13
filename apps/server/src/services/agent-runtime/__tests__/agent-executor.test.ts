// AgentExecutor + ReAct JSON Utils 单元测试
//
// 覆盖：
//   - looksLikeReActJSON 五键检测（含 5-key 误杀保护验证）
//   - sanitizeReActJSON 各优先级路径
//   - isKnowledgeBaseResult / extractKBChunks 辅助函数
//   - AgentExecutor 结构合约：route 值、构造函数
//   - Hardcoded fallback 常量

import { describe, it, expect } from "vitest";
import { AgentExecutor, isKnowledgeBaseResult, extractKBChunks } from "../agent-executor.js";
import {
  looksLikeReActJSON,
  sanitizeReActJSON,
} from "../react-json-utils.js";

// ═══════════════════════════════════════════════════════
// looksLikeReActJSON — 五键检测
// ═══════════════════════════════════════════════════════

describe("looksLikeReActJSON", () => {
  // ── 应命中（真 ReAct JSON）──

  it("应命中标准 ReAct JSON（含全部五键：observation, analysis, plan, decision）", () => {
    const reactJSON = JSON.stringify({
      observation: "用户查询订单状态",
      analysis: "需要调用订单查询工具",
      plan: "调用 search_order 工具获取订单信息",
      decision: { action: "tool_call", tool: "search_order", args: {} },
    });
    expect(looksLikeReActJSON(reactJSON)).toBe(true);
  });

  it("应命中带 respond decision 的 ReAct JSON", () => {
    const reactJSON = JSON.stringify({
      observation: "已获取订单数据",
      analysis: "订单状态为已发货",
      plan: "直接回答用户",
      decision: { action: "respond", content: "您的订单已发货。" },
    });
    expect(looksLikeReActJSON(reactJSON)).toBe(true);
  });

  it("应命中带 ask_user decision 的 ReAct JSON", () => {
    const reactJSON = JSON.stringify({
      observation: "用户消息不完整",
      analysis: "缺少订单号",
      plan: "向用户追问订单号",
      decision: { action: "ask_user", question: "请提供您的订单号" },
    });
    expect(looksLikeReActJSON(reactJSON)).toBe(true);
  });

  // ── 不应命中（非 ReAct 内容）──

  it("不应命中普通文本", () => {
    expect(looksLikeReActJSON("你好，有什么可以帮助你的？")).toBe(false);
  });

  it("不应命中 Markdown 代码块中的 JSON", () => {
    const markdownJSON = '```json\n{"name": "test", "value": 123}\n```';
    expect(looksLikeReActJSON(markdownJSON)).toBe(false);
  });

  it("不应命中不含 decision 键的四键 JSON（五键保护：防止误杀正常对话）", () => {
    // 边缘场景：用户要求输出含 observation/analysis/plan 的正常 JSON
    // 缺少 decision 键 → 不应被识别为 ReAct JSON
    const normalJSON = JSON.stringify({
      observation: "系统响应变慢",
      analysis: "可能是数据库连接池耗尽",
      plan: "建议增加连接池大小或检查慢查询",
    });
    expect(looksLikeReActJSON(normalJSON)).toBe(false);
  });

  it("不应命中空字符串", () => {
    expect(looksLikeReActJSON("")).toBe(false);
  });

  it("不应命中只有部分键的 JSON（缺 decision）", () => {
    const partial = '{"observation": "x", "analysis": "y"}';
    expect(looksLikeReActJSON(partial)).toBe(false);
  });

  it("不应命中 Markdown 讨论 ReAct 模式的文本", () => {
    const discussion =
      "在 ReAct 模式中，observation 表示观察结果，analysis 是分析过程，plan 是后续计划。";
    expect(looksLikeReActJSON(discussion)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// sanitizeReActJSON — 提取自然语言
// ═══════════════════════════════════════════════════════

describe("sanitizeReActJSON", () => {
  // ── 非 ReAct JSON → 原样返回 ──

  it("非 ReAct JSON 文本应原样返回", () => {
    const text = "您好，您的订单已发货，预计 3 天内送达。";
    expect(sanitizeReActJSON(text)).toBe(text);
  });

  it("普通 Markdown 应原样返回", () => {
    const md = "## 查询结果\n\n| 订单号 | 状态 |\n|--------|------|\n| 001 | 已发货 |";
    expect(sanitizeReActJSON(md)).toBe(md);
  });

  // ── decision.content 优先级最高 ──

  it("应提取 decision.content（respond 响应）", () => {
    const reactJSON = JSON.stringify({
      observation: "已查得订单信息",
      analysis: "订单状态正常",
      plan: "回复用户",
      decision: { action: "respond", content: "您的订单已发货，预计3天送达。" },
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("您的订单已发货，预计3天送达。");
  });

  // ── decision.question ──

  it("应提取 decision.question（ask_user 场景）", () => {
    const reactJSON = JSON.stringify({
      observation: "用户未提供订单号",
      analysis: "缺少关键信息",
      plan: "向用户询问订单号",
      decision: { action: "ask_user", question: "请提供您的订单号以便查询。" },
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("请提供您的订单号以便查询。");
  });

  // ── decision 是字符串（工具调用）→ null ──

  it("decision 为字符串（工具调用）时应返回 null", () => {
    const reactJSON = JSON.stringify({
      observation: "需要查询",
      analysis: "调用搜索工具",
      plan: "执行搜索",
      decision: "search_knowledge_base",
    });
    expect(sanitizeReActJSON(reactJSON)).toBeNull();
  });

  // ── 顶层 content / summary 次选 ──

  it("无 decision.content 时应提取顶层 content 字段", () => {
    const reactJSON = JSON.stringify({
      observation: "x",
      analysis: "y",
      plan: "z",
      decision: {},
      content: "这是顶层回复文本。",
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("这是顶层回复文本。");
  });

  it("无 content 时应提取顶层 summary 字段", () => {
    const reactJSON = JSON.stringify({
      observation: "x",
      analysis: "y",
      plan: "z",
      decision: {},
      summary: "操作摘要：已查询3条记录。",
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("操作摘要：已查询3条记录。");
  });

  // ── plan / observation 再次 ──

  it("无 content/summary 时应提取 plan 字段", () => {
    const reactJSON = JSON.stringify({
      observation: "x",
      analysis: "y",
      plan: "计划：先搜索KB，再调用订单API。",
      decision: {},
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("计划：先搜索KB，再调用订单API。");
  });

  it("无其他字段时应提取 observation 字段", () => {
    const reactJSON = JSON.stringify({
      observation: "观察到用户查询包含订单号 ORD-001。",
      analysis: "y",
      plan: "",
      decision: {},
    });
    expect(sanitizeReActJSON(reactJSON)).toBe("观察到用户查询包含订单号 ORD-001。");
  });

  // ── 无法提取 → null ──

  it("无法提取任何文本时应返回 null", () => {
    const reactJSON = JSON.stringify({
      observation: "",
      analysis: "",
      plan: "",
      decision: {},
    });
    expect(sanitizeReActJSON(reactJSON)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// isKnowledgeBaseResult —— KB 工具结果检测
// ═══════════════════════════════════════════════════════

describe("isKnowledgeBaseResult", () => {
  it("应识别标准 search_knowledge_base 返回结果", () => {
    const kbResult = JSON.stringify({
      found: true,
      results: [{ content: "退换货政策：7天无理由退换", score: 0.95 }],
    });
    expect(isKnowledgeBaseResult(kbResult)).toBe(true);
  });

  it("应识别 found: false 的 KB 结果（无匹配也应识别为 KB 结果）", () => {
    const kbResult = JSON.stringify({
      found: false,
      results: [],
    });
    expect(isKnowledgeBaseResult(kbResult)).toBe(true);
  });

  it("不应识别不含 results 键的普通 JSON", () => {
    const plainJSON = JSON.stringify({ name: "test", value: 123 });
    expect(isKnowledgeBaseResult(plainJSON)).toBe(false);
  });

  it("不应识别不含 found 键的 JSON", () => {
    const partialJSON = JSON.stringify({ results: [{ content: "x" }] });
    expect(isKnowledgeBaseResult(partialJSON)).toBe(false);
  });

  it("不应识别普通文本", () => {
    expect(isKnowledgeBaseResult("这是一段普通的工具输出文本")).toBe(false);
  });

  it("不应识别空字符串", () => {
    expect(isKnowledgeBaseResult("")).toBe(false);
  });

  it("不应识别 Markdown 中引用了 results/found 词汇的文本（不含 JSON 键的引号）", () => {
    // results 和 found 作为普通词汇出现，但没有 JSON 键所需的双引号
    const markdown = "The search results were found in the database.";
    // "results" 有引号但 "found" 没有引号 → 不匹配
    expect(isKnowledgeBaseResult(markdown)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// extractKBChunks —— KB chunk 文本提取
// ═══════════════════════════════════════════════════════

describe("extractKBChunks", () => {
  it("应提取有效的 KB 搜索结果中的 content 字段", () => {
    const kbResult = JSON.stringify({
      found: true,
      results: [
        { content: "退换货政策：7天无理由退换", score: 0.95 },
        { content: "退款流程：3-5个工作日到账", score: 0.87 },
      ],
    });
    const chunks = extractKBChunks(kbResult);
    expect(chunks).toEqual([
      "退换货政策：7天无理由退换",
      "退款流程：3-5个工作日到账",
    ]);
  });

  it("found: false 时应返回空数组", () => {
    const kbResult = JSON.stringify({
      found: false,
      results: [],
    });
    expect(extractKBChunks(kbResult)).toEqual([]);
  });

  it("应过滤掉 content 为空的条目", () => {
    const kbResult = JSON.stringify({
      found: true,
      results: [
        { content: "有效内容", score: 0.9 },
        { content: "", score: 0.5 },
        { content: "   ", score: 0.3 },
      ],
    });
    // "   " 转 String 后不为空（三个空格），只有 "" 被过滤
    const chunks = extractKBChunks(kbResult);
    expect(chunks).toEqual(["有效内容", "   "]);
  });

  it("普通文本应返回空数组（不匹配 JSON 键特征）", () => {
    expect(extractKBChunks("没有 results 和 found 键的普通文本")).toEqual([]);
  });

  it("畸形的 JSON 应返回空数组（安全降级）", () => {
    expect(extractKBChunks('{"found": true, "results": [broken]}')).toEqual([]);
  });

  it("results 非数组时应返回空数组", () => {
    const kbResult = JSON.stringify({
      found: true,
      results: "not an array",
    });
    expect(extractKBChunks(kbResult)).toEqual([]);
  });

  it("results 中包含非对象元素时应跳过", () => {
    const kbResult = JSON.stringify({
      found: true,
      results: [
        { content: "有效", score: 0.9 },
        "plain string",
        123,
        null,
        { content: "另一条有效", score: 0.8 },
      ],
    });
    const chunks = extractKBChunks(kbResult);
    expect(chunks).toEqual(["有效", "另一条有效"]);
  });

  it("空字符串应返回空数组", () => {
    expect(extractKBChunks("")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// AgentExecutor 结构合约
// ═══════════════════════════════════════════════════════

describe("AgentExecutor", () => {
  it("route 应始终为 'TASK'", () => {
    const executor = new AgentExecutor();
    expect(executor.route).toBe("TASK");
  });

  it("execute 方法应存在且为函数", () => {
    const executor = new AgentExecutor();
    expect(typeof executor.execute).toBe("function");
    // AsyncGenerator 特征：调用返回可迭代对象
    const gen = executor.execute({
      conversationId: "conv-test",
      sessionId: "session-test",
      userMessage: "测试消息",
      history: [],
      knowledgeContext: "",
      knowledgeResults: [],
      kbChunks: [],
      memoryContext: "",
      injectedMemories: [],
      resolvedModel: "gpt-4o-mini",
      providerName: "openai",
      withinServiceHours: true,
      assistantMsgId: "msg-test",
      intent: "其他咨询",
    });
    expect(gen).toBeDefined();
    expect(typeof gen.next).toBe("function");
    expect(typeof gen.return).toBe("function");
    expect(typeof gen.throw).toBe("function");
    // 清理 generator，避免 dangling async 操作
    gen.return(undefined).catch(() => {});
  });
});
