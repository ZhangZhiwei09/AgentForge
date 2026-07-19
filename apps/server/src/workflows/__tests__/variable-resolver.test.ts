// VariableResolver & SafeEvaluator 单元测试 — {{var}} 模板解析与安全表达式求值
import { describe, it, expect } from "vitest";
import {
  VariableResolver,
  SafeEvaluator,
  variableResolver,
  type VariableContext,
} from "../variable-resolver.js";

// ---- Helpers ----

function makeContext(overrides?: Partial<VariableContext>): VariableContext {
  const base: VariableContext = {
    runId: "run-001",
    variables: {
      name: "Alice",
      age: 30,
      score: 85.5,
      active: true,
      tags: ["vip", "enterprise"],
      config: { theme: "dark", lang: "zh" },
      count: 42,
    },
    // stepResults values are raw step outputs — .output in the template
    // is a syntactic marker, not an actual field name.
    stepResults: {
      step1: { text: "hello world", confidence: 0.95 },
      step2: {
        items: [
          { id: 1, name: "ItemA" },
          { id: 2, name: "ItemB" },
        ],
        meta: { version: 2, flags: { verified: true } },
      },
      step3: "simple string result",
      step4: 42,
      step5: { status: "ok" },
      step6: null,
      step7: undefined,
    },
  };

  if (!overrides) return base;

  return {
    runId: overrides.runId ?? base.runId,
    variables: overrides.variables
      ? { ...base.variables, ...overrides.variables }
      : base.variables,
    stepResults: overrides.stepResults ?? base.stepResults,
  };
}

// =============================================================================
// VariableResolver
// =============================================================================

describe("VariableResolver", () => {
  // ---------------------------------------------------------------------------
  // 构造 & 实例化
  // ---------------------------------------------------------------------------
  describe("构造 & 实例化", () => {
    it("variableResolver 是 VariableResolver 的实例", () => {
      expect(variableResolver).toBeInstanceOf(VariableResolver);
    });

    it("每次 new VariableResolver() 创建独立实例", () => {
      const a = new VariableResolver();
      const b = new VariableResolver();
      expect(a).not.toBe(b);
    });
  });

  // ---------------------------------------------------------------------------
  // resolve()
  // ---------------------------------------------------------------------------
  describe("resolve", () => {
    it("替换 {{var}} 为 variables 中的值", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("你好，{{name}}", ctx);
      expect(result).toBe("你好，Alice");
    });

    it("替换 {{__run_id__}} 为 context.runId", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("运行ID: {{__run_id__}}", ctx);
      expect(result).toBe("运行ID: run-001");
    });

    it("替换 {{__timestamp__}} 为当前时间戳", () => {
      const ctx = makeContext();
      const now = Date.now();
      const result = variableResolver.resolve("ts={{__timestamp__}}", ctx);
      const ts = result.replace("ts=", "");
      const parsed = Number(ts);
      expect(Number.isInteger(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(now);
      expect(parsed).toBeLessThanOrEqual(now + 1000);
    });

    it("未解析的变量保持原始 {{var}} 形式", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("值: {{unknown_var}}", ctx);
      expect(result).toBe("值: {{unknown_var}}");
    });

    it("step output 引用 — {{step.output.field}} 提取嵌套字段", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step1.output.text}}", ctx);
      expect(result).toBe("hello world");
    });

    it("step output 整个 output 返回 JSON — 使用 {{step.output.}} 语法", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step1.output.}}", ctx);
      expect(JSON.parse(result)).toEqual({
        text: "hello world",
        confidence: 0.95,
      });
    });

    it("step output 嵌套路径 — 多层点号访问", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{step2.output.meta.flags.verified}}",
        ctx,
      );
      expect(result).toBe("true");
    });

    it("step output 嵌套路径 — 只有 .output. 无后续路径，返回 JSON", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step2.output.}}", ctx);
      expect(JSON.parse(result)).toEqual(ctx.stepResults.step2);
    });

    it("step output 字段不存在 — 返回原始模板", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{step1.output.nonexistent}}",
        ctx,
      );
      expect(result).toBe("{{step1.output.nonexistent}}");
    });

    it("step output 数组索引访问 — items[0].name", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{step2.output.items[0].name}}",
        ctx,
      );
      expect(result).toBe("ItemA");
    });

    it("step output 数组索引访问 — items[1].id", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{step2.output.items[1].id}}",
        ctx,
      );
      expect(result).toBe("2");
    });

    it("非字符串类型的变量值 JSON.stringify 序列化", () => {
      const ctx = makeContext();
      // age is number 30, but via variable path: variables["age"] is number 30
      // resolve checks typeof val === "string" → false → JSON.stringify(30) → "30"
      const result = variableResolver.resolve("年龄: {{age}}", ctx);
      expect(result).toBe("年龄: 30");
    });

    it("对象类型变量 JSON.stringify 序列化", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("配置: {{config}}", ctx);
      expect(result).toBe('配置: {"theme":"dark","lang":"zh"}');
    });

    it("布尔类型变量序列化", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("活跃: {{active}}", ctx);
      expect(result).toBe("活跃: true");
    });

    it("数组类型变量序列化", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("标签: {{tags}}", ctx);
      expect(result).toBe('标签: ["vip","enterprise"]');
    });

    it("多个模板同时替换", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "用户 {{name}}（{{age}}岁）得分 {{score}}",
        ctx,
      );
      expect(result).toBe("用户 Alice（30岁）得分 85.5");
    });

    it("混合已解析和未解析的模板", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{name}} 的 {{unknown}} 值",
        ctx,
      );
      expect(result).toBe("Alice 的 {{unknown}} 值");
    });

    it("step output 简写形式 — {{step_id}} 返回整个 output（字符串）", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step3}}", ctx);
      expect(result).toBe("simple string result");
    });

    it("step output 简写 — 对象类型 output JSON 序列化", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step5}}", ctx);
      expect(JSON.parse(result)).toEqual({ status: "ok" });
    });

    it("step output 简写 — 数字类型 output", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step4}}", ctx);
      expect(result).toBe("42");
    });

    it("step 简写值为 null — JSON.stringify 序列化为 'null'", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{step6}}", ctx);
      expect(result).toBe("null");
    });

    it("step 不存在 — 返回原始模板", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{nonexistent_step.output.field}}",
        ctx,
      );
      expect(result).toBe("{{nonexistent_step.output.field}}");
    });

    it("step output 引用 — step 值为 null，返回原始模板", () => {
      const ctx = makeContext({
        stepResults: { s: null },
      });
      const result = variableResolver.resolve("{{s.output.field}}", ctx);
      expect(result).toBe("{{s.output.field}}");
    });

    it("step output 引用 — step 值为 undefined，返回原始模板", () => {
      const ctx = makeContext({
        stepResults: { s: undefined },
      });
      const result = variableResolver.resolve("{{s.output.field}}", ctx);
      expect(result).toBe("{{s.output.field}}");
    });

    it("step output 引用 — 嵌套路径中间值为 null 返回原始模板", () => {
      const ctx = makeContext({
        stepResults: {
          bad: { data: null },
        },
      });
      const result = variableResolver.resolve(
        "{{bad.output.data.deeper}}",
        ctx,
      );
      expect(result).toBe("{{bad.output.data.deeper}}");
    });

    it("step output 引用 — 嵌套路径中间值为 undefined 返回原始模板", () => {
      const ctx = makeContext({
        stepResults: {
          bad: { data: undefined },
        },
      });
      const result = variableResolver.resolve(
        "{{bad.output.data.deeper}}",
        ctx,
      );
      expect(result).toBe("{{bad.output.data.deeper}}");
    });

    it("变量优先级 — workflow variable 优先于 stepResults 简写", () => {
      const ctx = makeContext({
        variables: { step3: "from variables" },
        stepResults: { step3: "from steps" },
      });
      // {{step3}} → no stepMatch → variables["step3"]="from variables" (defined) → returns it
      const result = variableResolver.resolve("{{step3}}", ctx);
      expect(result).toBe("from variables");
    });

    it("模板包含前导/尾随空白字符 — {{  name  }} 支持空格", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("{{  name  }}", ctx);
      expect(result).toBe("Alice");
    });

    it("无模板字符串原样返回", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("纯文本无变量", ctx);
      expect(result).toBe("纯文本无变量");
    });

    it("空字符串输入", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve("", ctx);
      expect(result).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // resolveObject()
  // ---------------------------------------------------------------------------
  describe("resolveObject", () => {
    it("解析字符串中的模板", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("你好，{{name}}", ctx);
      expect(result).toBe("你好，Alice");
    });

    it("解析嵌套对象中的模板 — 单一模板值自动类型转换", () => {
      const ctx = makeContext();
      const input = {
        greeting: "你好，{{name}}",
        details: {
          score: "{{score}}", // single template → coerced to number 85.5
          meta: { runId: "{{__run_id__}}" },
        },
      };
      const result = variableResolver.resolveObject(input, ctx);
      expect(result).toEqual({
        greeting: "你好，Alice",
        details: {
          score: 85.5, // single-template coercion: "85.5" → Number → 85.5
          meta: { runId: "run-001" },
        },
      });
    });

    it("解析数组中每个元素的模板", () => {
      const ctx = makeContext();
      const input = ["{{name}}", "年龄: {{age}}", "无变量"];
      const result = variableResolver.resolveObject(input, ctx);
      expect(result).toEqual(["Alice", "年龄: 30", "无变量"]);
    });

    it("单一模板字符串自动类型转换 — 数字", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("{{age}}", ctx);
      expect(result).toBe(30);
      expect(typeof result).toBe("number");
    });

    it("单一模板字符串自动类型转换 — 布尔 true", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("{{active}}", ctx);
      expect(result).toBe(true);
      expect(typeof result).toBe("boolean");
    });

    it("单一模板字符串自动类型转换 — 布尔 false（通过变量间接测试）", () => {
      const ctx = makeContext({
        variables: { flag: false },
      });
      const result = variableResolver.resolveObject("{{flag}}", ctx);
      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    });

    it("单一模板字符串自动类型转换 — 解析为 JSON 对象", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("{{config}}", ctx);
      expect(result).toEqual({ theme: "dark", lang: "zh" });
    });

    it("单一模板字符串自动类型转换 — 解析为 JSON 数组", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("{{tags}}", ctx);
      expect(result).toEqual(["vip", "enterprise"]);
    });

    it("单一模板字符串 — 纯数字字符串", () => {
      const ctx = makeContext({
        variables: { numStr: "42" },
      });
      const result = variableResolver.resolveObject("{{numStr}}", ctx);
      expect(result).toBe(42);
      expect(typeof result).toBe("number");
    });

    it("单一模板字符串 — 带小数数字", () => {
      const ctx = makeContext({
        variables: { pi: "3.14" },
      });
      const result = variableResolver.resolveObject("{{pi}}", ctx);
      expect(result).toBe(3.14);
      expect(typeof result).toBe("number");
    });

    it("单一模板字符串 — 无法 JSON 解析的对象值降级为字符串", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("{{step3}}", ctx);
      expect(result).toBe("simple string result");
    });

    it("非模板字符串原样返回", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("纯文本", ctx);
      expect(result).toBe("纯文本");
    });

    it("非字符串原始值原样返回", () => {
      const ctx = makeContext();
      expect(variableResolver.resolveObject(42, ctx)).toBe(42);
      expect(variableResolver.resolveObject(true, ctx)).toBe(true);
      expect(variableResolver.resolveObject(null, ctx)).toBeNull();
      expect(variableResolver.resolveObject(undefined, ctx)).toBeUndefined();
    });

    it("空对象原样返回", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject({}, ctx);
      expect(result).toEqual({});
    });

    it("空数组原样返回", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject([], ctx);
      expect(result).toEqual([]);
    });

    it("深层嵌套对象 + 数组混合解析", () => {
      const ctx = makeContext();
      const input = {
        users: [
          { name: "{{name}}", id: "{{__run_id__}}" },
          { name: "静态名", id: "no-template" },
        ],
        meta: { version: "{{score}}" },
      };
      const result = variableResolver.resolveObject(input, ctx);
      expect(result).toEqual({
        users: [
          { name: "Alice", id: "run-001" },
          { name: "静态名", id: "no-template" },
        ],
        meta: { version: 85.5 }, // single-template coercion
      });
    });

    it("resolveObject 对不含 {{ 的字符串直接返回原值", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject("no brackets at all", ctx);
      expect(result).toBe("no brackets at all");
    });

    it("字符串包含 {{ 但不是完整模板，通过 resolve 处理", () => {
      const ctx = makeContext();
      const result = variableResolver.resolveObject(
        "前缀 {{name}} 后缀",
        ctx,
      );
      expect(result).toBe("前缀 Alice 后缀");
    });
  });

  // ---------------------------------------------------------------------------
  // getNestedValue（通过 resolve + step output 间接测试）
  // ---------------------------------------------------------------------------
  describe("getNestedValue（通过 resolve step output 间接测试）", () => {
    it("简单字段访问", () => {
      const ctx = makeContext({
        stepResults: {
          s: { value: "hello" },
        },
      });
      const result = variableResolver.resolve("{{s.output.value}}", ctx);
      expect(result).toBe("hello");
    });

    it("嵌套点号路径 — 多层字段", () => {
      const ctx = makeContext({
        stepResults: {
          s: { a: { b: { c: "deep" } } },
        },
      });
      const result = variableResolver.resolve("{{s.output.a.b.c}}", ctx);
      expect(result).toBe("deep");
    });

    it("数组索引 [0] 路径", () => {
      const ctx = makeContext({
        stepResults: {
          s: { items: ["first", "second"] },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.items[0]}}",
        ctx,
      );
      expect(result).toBe("first");
    });

    it("数组索引 + 嵌套字段 — items[1].name", () => {
      const ctx = makeContext();
      const result = variableResolver.resolve(
        "{{step2.output.items[1].name}}",
        ctx,
      );
      expect(result).toBe("ItemB");
    });

    it("中间值为 null 时返回 undefined（→ 原始模板）", () => {
      const ctx = makeContext({
        stepResults: {
          s: { middle: null },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.middle.field}}",
        ctx,
      );
      expect(result).toBe("{{s.output.middle.field}}");
    });

    it("中间值为 undefined 时返回 undefined（→ 原始模板）", () => {
      const ctx = makeContext({
        stepResults: {
          s: { middle: undefined },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.middle.field}}",
        ctx,
      );
      expect(result).toBe("{{s.output.middle.field}}");
    });

    it("访问不存在字段返回 undefined（→ 原始模板）", () => {
      const ctx = makeContext({
        stepResults: {
          s: { only: "this" },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.nonexistent}}",
        ctx,
      );
      expect(result).toBe("{{s.output.nonexistent}}");
    });

    it("路径中间值为非对象（数字）时返回 undefined", () => {
      const ctx = makeContext({
        stepResults: {
          s: { num: 42 },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.num.field}}",
        ctx,
      );
      expect(result).toBe("{{s.output.num.field}}");
    });

    it("路径中间值为字符串时返回 undefined", () => {
      const ctx = makeContext({
        stepResults: {
          s: { str: "hello" },
        },
      });
      const result = variableResolver.resolve(
        "{{s.output.str.field}}",
        ctx,
      );
      expect(result).toBe("{{s.output.str.field}}");
    });
  });
});

// =============================================================================
// SafeEvaluator
// =============================================================================

describe("SafeEvaluator", () => {
  // SafeEvaluator 所有方法都是 static，不需要实例化

  // ---------------------------------------------------------------------------
  // evaluate()
  // ---------------------------------------------------------------------------
  describe("evaluate", () => {
    it("简单比较 — > 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 > 3", ctx);
      expect(result).toBe(true);
    });

    it("简单比较 — > 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("2 > 10", ctx);
      expect(result).toBe(false);
    });

    it("简单比较 — < 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("1 < 100", ctx);
      expect(result).toBe(true);
    });

    it("简单比较 — < 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("100 < 1", ctx);
      expect(result).toBe(false);
    });

    it("简单比较 — >= 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 >= 5", ctx);
      expect(result).toBe(true);
    });

    it("简单比较 — <= 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("0 <= 0", ctx);
      expect(result).toBe(true);
    });

    it("相等性 — === 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("'abc' === 'abc'", ctx);
      expect(result).toBe(true);
    });

    it("相等性 — === 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("'abc' === 'xyz'", ctx);
      expect(result).toBe(false);
    });

    it("不等 — !== 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("'abc' !== 'xyz'", ctx);
      expect(result).toBe(true);
    });

    it("不等 — !== 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("'abc' !== 'abc'", ctx);
      expect(result).toBe(false);
    });

    it("松相等 — == 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 == 5", ctx);
      expect(result).toBe(true);
    });

    it("松不等 — != 为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 != 10", ctx);
      expect(result).toBe(true);
    });

    it("字符串包含 — includes", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'hello world' includes 'world'",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("字符串包含 — includes 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'hello' includes 'xyz'",
        ctx,
      );
      expect(result).toBe(false);
    });

    it("字符串前缀 — startsWith", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'hello world' startsWith 'hello'",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("字符串前缀 — startsWith 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'hello' startsWith 'world'",
        ctx,
      );
      expect(result).toBe(false);
    });

    it("字符串后缀 — endsWith", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'hello world' endsWith 'world'",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("字符串后缀 — endsWith 为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'world' endsWith 'hello'",
        ctx,
      );
      expect(result).toBe(false);
    });

    it("contains 别名等同于 includes", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'abcdef' contains 'cde'",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("逻辑 AND — && 两侧都为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 > 3 && 10 > 1", ctx);
      expect(result).toBe(true);
    });

    it("逻辑 AND — 一侧为假则整体为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 > 3 && 10 < 1", ctx);
      expect(result).toBe(false);
    });

    it("逻辑 OR — 一侧为真则整体为真", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 < 3 || 10 > 1", ctx);
      expect(result).toBe(true);
    });

    it("逻辑 OR — 两侧都为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("5 < 3 || 10 < 1", ctx);
      expect(result).toBe(false);
    });

    it("逻辑 AND 多条件链 — 3 个条件", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("1 > 0 && 2 > 1 && 3 > 2", ctx);
      expect(result).toBe(true);
    });

    it("布尔字面量 — true", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("true", ctx);
      expect(result).toBe(true);
    });

    it("布尔字面量 — false", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("false", ctx);
      expect(result).toBe(false);
    });

    it("真值检查 — 非空字符串为 true", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("hello", ctx);
      expect(result).toBe(true);
    });

    it("真值检查 — 空字符串为 false", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("", ctx);
      expect(result).toBe(false);
    });

    it("真值检查 — 字符串 '0' 为非空串，真值为 true", () => {
      const ctx = makeContext();
      // "0" is a non-empty string; evaluateSimple sees no operator,
      // falls to truthy check: Boolean("0") = true
      const result = SafeEvaluator.evaluate("0", ctx);
      expect(result).toBe(true);
    });

    it("先解析变量再求值 — {{var}} > 阈值", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("{{score}} > 80", ctx);
      expect(result).toBe(true);
    });

    it("先解析变量再求值 — 条件为假", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("{{score}} < 10", ctx);
      expect(result).toBe(false);
    });

    it("变量 + 逻辑组合 — && 连接", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "{{score}} > 80 && {{active}} === true",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("变量 + 逻辑组合 — || 连接", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "{{score}} < 0 || {{active}} === true",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("字符串字面量比较 — 单引号包裹", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate(
        "'active' === 'active'",
        ctx,
      );
      expect(result).toBe(true);
    });

    it("数字字符串标准化比较 — normalize 将数字字符串转为 Number", () => {
      const ctx = makeContext();
      // normalize('123') = 123, normalize(123) = 123 → 123 === 123 → true
      const result = SafeEvaluator.evaluate("'123' === 123", ctx);
      expect(result).toBe(true);
    });

    it("无空格操作符无法匹配 — 回退到真值检查", () => {
      const ctx = makeContext();
      // "1>0" — no spaces around >, so findOperatorOutsideQuotes("1>0", " > ") returns -1
      // Falls through: no other operator found → truthy check → Boolean("1>0") = true
      const result = SafeEvaluator.evaluate("1>0", ctx);
      expect(result).toBe(true);
    });

    it("空表达式字符串 — 真值检查为 false", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluate("", ctx);
      expect(result).toBe(false);
    });

    it("未解析变量保留原样，非空字符串真值为 true", () => {
      const ctx = makeContext();
      // {{unknown_var}} is not resolved → evaluateSimple sees "{{unknown_var}}"
      // No operator, no spaces → truthy check → Boolean("{{unknown_var}}") = true
      const result = SafeEvaluator.evaluate("{{unknown_var}}", ctx);
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // stripQuotes (private static — accessed via type cast for testing)
  // ---------------------------------------------------------------------------
  describe("stripQuotes", () => {
    const evaluator = SafeEvaluator as unknown as {
      stripQuotes(val: string): string;
    };

    it("移除单引号", () => {
      expect(evaluator.stripQuotes("'hello'")).toBe("hello");
    });

    it("移除双引号", () => {
      expect(evaluator.stripQuotes('"world"')).toBe("world");
    });

    it("无引号字符串原样返回", () => {
      expect(evaluator.stripQuotes("no-quotes")).toBe("no-quotes");
    });

    it("只有开始引号不处理", () => {
      expect(evaluator.stripQuotes("'partial")).toBe("'partial");
    });

    it("只有结束引号不处理", () => {
      expect(evaluator.stripQuotes('partial"')).toBe('partial"');
    });

    it("引号不匹配 — 单双混用不处理", () => {
      expect(evaluator.stripQuotes("'mixed\"")).toBe("'mixed\"");
    });

    it("空引号字符串 — '' 变为空", () => {
      expect(evaluator.stripQuotes("''")).toBe("");
    });

    it("空引号字符串 — \"\" 变为空", () => {
      expect(evaluator.stripQuotes('""')).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // coerceValue (private static — accessed via type cast for testing)
  // ---------------------------------------------------------------------------
  describe("coerceValue", () => {
    const evaluator = SafeEvaluator as unknown as {
      coerceValue(val: string): unknown;
    };

    it('"123" 转换为数字 123', () => {
      const result = evaluator.coerceValue("123");
      expect(result).toBe(123);
      expect(typeof result).toBe("number");
    });

    it('"0" 转换为数字 0', () => {
      const result = evaluator.coerceValue("0");
      expect(result).toBe(0);
      expect(typeof result).toBe("number");
    });

    it('"-42" 转换为数字 -42', () => {
      const result = evaluator.coerceValue("-42");
      expect(result).toBe(-42);
    });

    it('"3.14" 转换为数字 3.14', () => {
      const result = evaluator.coerceValue("3.14");
      expect(result).toBe(3.14);
    });

    it('"true" 转换为布尔 true', () => {
      const result = evaluator.coerceValue("true");
      expect(result).toBe(true);
      expect(typeof result).toBe("boolean");
    });

    it('"false" 转换为布尔 false', () => {
      const result = evaluator.coerceValue("false");
      expect(result).toBe(false);
      expect(typeof result).toBe("boolean");
    });

    it('"null" 转换为 null', () => {
      const result = evaluator.coerceValue("null");
      expect(result).toBeNull();
    });

    it('"undefined" 转换为 undefined', () => {
      const result = evaluator.coerceValue("undefined");
      expect(result).toBeUndefined();
    });

    it("普通字符串原样返回", () => {
      const result = evaluator.coerceValue("hello world");
      expect(result).toBe("hello world");
    });

    it("空字符串原样返回", () => {
      const result = evaluator.coerceValue("");
      expect(result).toBe("");
    });

    it('"NaN" 作为普通字符串处理', () => {
      const result = evaluator.coerceValue("NaN");
      expect(result).toBe("NaN");
    });

    it('"Infinity" 作为普通字符串处理', () => {
      const result = evaluator.coerceValue("Infinity");
      expect(result).toBe("Infinity");
    });
  });

  // ---------------------------------------------------------------------------
  // normalize (private static — accessed via type cast for testing)
  // ---------------------------------------------------------------------------
  describe("normalize", () => {
    const evaluator = SafeEvaluator as unknown as {
      normalize(val: unknown): string | number;
    };

    it("数字类型原样返回", () => {
      expect(evaluator.normalize(42)).toBe(42);
    });

    it("负数原样返回", () => {
      expect(evaluator.normalize(-10)).toBe(-10);
    });

    it("小数原样返回", () => {
      expect(evaluator.normalize(3.14)).toBe(3.14);
    });

    it("数字字符串转换为数字", () => {
      const result = evaluator.normalize("123");
      expect(result).toBe(123);
      expect(typeof result).toBe("number");
    });

    it('"0" 字符串转换为数字', () => {
      const result = evaluator.normalize("0");
      expect(result).toBe(0);
    });

    it("负数数字字符串转换为数字", () => {
      const result = evaluator.normalize("-99");
      expect(result).toBe(-99);
    });

    it("小数数字字符串转换为数字", () => {
      const result = evaluator.normalize("1.5");
      expect(result).toBe(1.5);
    });

    it("非数字字符串原样返回", () => {
      const result = evaluator.normalize("hello");
      expect(result).toBe("hello");
    });

    it('"true" 字符串不被 normalize 转换（仅 coerceValue 处理布尔）', () => {
      const result = evaluator.normalize("true");
      expect(result).toBe("true");
    });

    it("空字符串原样返回", () => {
      const result = evaluator.normalize("");
      expect(result).toBe("");
    });

    it("boolean 值 normalize — String(true) = 'true'，不是数字 → 返回 'true'", () => {
      const result = evaluator.normalize(true);
      expect(result).toBe("true");
    });

    it("null normalize — String(null) = 'null'，不是数字 → 返回 'null'", () => {
      const result = evaluator.normalize(null);
      expect(result).toBe("null");
    });
  });

  // ---------------------------------------------------------------------------
  // findOperatorOutsideQuotes (private static — accessed via type cast for testing)
  // ---------------------------------------------------------------------------
  describe("findOperatorOutsideQuotes", () => {
    const evaluator = SafeEvaluator as unknown as {
      findOperatorOutsideQuotes(str: string, op: string): number;
    };

    it("在引号外部找到操作符，返回正确索引", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "hello > world",
        " > ",
      );
      expect(result).toBe(5);
    });

    it("在引号内部的操作符被忽略，返回 -1", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "'this > is' ignored",
        " > ",
      );
      expect(result).toBe(-1);
    });

    it("双引号内部的操作符被忽略", () => {
      // Indices: 0=", 1=a, 2=space, 3=>, 4=space, 5=b, 6=", 7-14=outside,
      // 15=space, 16=>, 17=space → slice(15,18) = " > " → index 15
      const result = evaluator.findOperatorOutsideQuotes(
        '"a > b" outside > here',
        " > ",
      );
      expect(result).toBe(15);
    });

    it("无操作符时返回 -1", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "no operator here",
        " > ",
      );
      expect(result).toBe(-1);
    });

    it("多个操作符，返回第一个在引号外的位置", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "a > b > c",
        " > ",
      );
      expect(result).toBe(1);
    });

    it("查找 includes 操作符", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "value includes sub",
        " includes ",
      );
      expect(result).toBe(5);
    });

    it("引号未闭合 — 后续所有内容视为引号内，返回 -1", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        "'unclosed > here",
        " > ",
      );
      expect(result).toBe(-1);
    });

    it("交替引号 — 同类型引号切换后外部操作符被找到", () => {
      // 'a' → quote opens at 0, closes at 2. " > " starts at idx 3 → outside quote.
      const result = evaluator.findOperatorOutsideQuotes("'a' > 'b'", " > ");
      expect(result).toBe(3);
    });

    it("操作符长度超出字符串长度返回 -1", () => {
      const result = evaluator.findOperatorOutsideQuotes("x", " >>> ");
      expect(result).toBe(-1);
    });

    it("操作符在字符串开头", () => {
      const result = evaluator.findOperatorOutsideQuotes(" > suffix", " > ");
      expect(result).toBe(0);
    });

    it("操作符在字符串末尾", () => {
      const result = evaluator.findOperatorOutsideQuotes("prefix > ", " > ");
      expect(result).toBe(6);
    });

    it("引号关闭后，后面的操作符被正确找到", () => {
      const result = evaluator.findOperatorOutsideQuotes(
        '"quoted" > free',
        " > ",
      );
      // index 0: " opens, index 7: " closes, idx 8: " > " matches
      expect(result).toBe(8);
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateTemplate()
  // ---------------------------------------------------------------------------
  describe("evaluateTemplate", () => {
    it("解析 JSON 对象模板", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluateTemplate(
        '{"name": "{{name}}", "id": "{{__run_id__}}"}',
        ctx,
      );
      expect(result).toEqual({ name: "Alice", id: "run-001" });
    });

    it("解析 JSON 数组模板", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluateTemplate(
        '["{{name}}", "{{__run_id__}}"]',
        ctx,
      );
      expect(result).toEqual(["Alice", "run-001"]);
    });

    it("模板非有效 JSON 时降级为纯字符串", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluateTemplate("用户: {{name}}", ctx);
      expect(result).toBe("用户: Alice");
    });

    it("无模板的 JSON 正常解析", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluateTemplate('{"static": "value"}', ctx);
      expect(result).toEqual({ static: "value" });
    });

    it("空字符串输入 — 非有效 JSON 降级为空字符串", () => {
      const ctx = makeContext();
      const result = SafeEvaluator.evaluateTemplate("", ctx);
      expect(result).toBe("");
    });
  });
});

// =============================================================================
// 集成场景测试
// =============================================================================

describe("VariableResolver + SafeEvaluator 集成", () => {
  it("resolve + evaluate 串联 — 先解析变量再条件求值", () => {
    const ctx = makeContext({
      variables: {
        threshold: "60",
        status: "pass",
      },
    });
    const message = variableResolver.resolve(
      "分数 {{score}}，阈值 {{threshold}}，状态 {{status}}",
      ctx,
    );
    expect(message).toBe("分数 85.5，阈值 60，状态 pass");
  });

  it("resolveObject 构建结构化参数后 evaluate 验证", () => {
    const ctx = makeContext();
    const args = variableResolver.resolveObject(
      {
        userId: "{{__run_id__}}",
        score: "{{score}}",
        active: "{{active}}",
      },
      ctx,
    );
    // single-template coercion: score string → number, active string → boolean
    expect(args).toEqual({
      userId: "run-001",
      score: 85.5,
      active: true,
    });
  });

  it("多 step output 引用组合", () => {
    const ctx = makeContext();
    const result = variableResolver.resolve(
      "第一步: {{step1.output.text}}，置信度: {{step1.output.confidence}}",
      ctx,
    );
    expect(result).toBe("第一步: hello world，置信度: 0.95");
  });

  it("工作流条件分支场景 — 分数 > 60 且用户活跃", () => {
    const ctx = makeContext();
    const condition = SafeEvaluator.evaluate(
      "{{score}} > 60 && {{active}} === true",
      ctx,
    );
    expect(condition).toBe(true);
  });

  it("工作流条件分支场景 — 条件不满足", () => {
    const ctx = makeContext({
      variables: { status: "inactive" },
    });
    const condition = SafeEvaluator.evaluate(
      "{{score}} > 90 && {{active}} === false",
      ctx,
    );
    expect(condition).toBe(false);
  });

  it("resolveObject 构建数组参数并解析每个元素", () => {
    const ctx = makeContext();
    const input = {
      names: ["{{name}}", "Bob", "{{__run_id__}}"],
      scores: [{ value: "{{score}}" }, { value: 100 }],
    };
    const result = variableResolver.resolveObject(input, ctx);
    expect(result).toEqual({
      names: ["Alice", "Bob", "run-001"],
      scores: [{ value: 85.5 }, { value: 100 }],
    });
  });
});
