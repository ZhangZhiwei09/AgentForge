// RunContext 单元测试
// ===================
// 验证不可变运行时上下文的完整契约：
// - RunContext 的 runId、ancestry、signal 字段不可变
// - createRunContext / createChildContext 的构造正确性
// - Object.freeze 阻止属性赋值
// - ancestry 数组独立（不共享引用）
// - AbortSignal 正确继承
//
// 源码：src/runtime/context.ts

import { describe, it, expect } from "vitest";
import {
  createRunContext,
  createChildContext,
  type RunContext,
} from "../context.js";

// ═══════════════════════════════════════════════════════
// createRunContext() — 根上下文
// ═══════════════════════════════════════════════════════

describe("createRunContext", () => {
  // ── runId ──

  describe("runId", () => {
    it("应自动生成唯一的 runId（UUID v4 格式）", () => {
      const ctx1 = createRunContext(new AbortController().signal);
      const ctx2 = createRunContext(new AbortController().signal);
      const ctx3 = createRunContext(new AbortController().signal);

      // 每次调用生成不同的 ID
      expect(ctx1.runId).not.toBe(ctx2.runId);
      expect(ctx1.runId).not.toBe(ctx3.runId);
      expect(ctx2.runId).not.toBe(ctx3.runId);

      // UUID v4 格式：xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
      const uuidV4Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(ctx1.runId).toMatch(uuidV4Regex);
      expect(ctx2.runId).toMatch(uuidV4Regex);
      expect(ctx3.runId).toMatch(uuidV4Regex);
    });

    it("应接受显式传入的 runId", () => {
      const explicitId = "custom-run-id-001";
      const ctx = createRunContext(
        new AbortController().signal,
        explicitId,
      );

      expect(ctx.runId).toBe(explicitId);
    });

    it("传入空字符串时应保留空字符串（不自动生成）", () => {
      const ctx = createRunContext(new AbortController().signal, "");

      expect(ctx.runId).toBe("");
    });

    it("传入 undefined 作为 runId 时应自动生成 UUID", () => {
      const ctx = createRunContext(
        new AbortController().signal,
        undefined,
      );

      const uuidV4Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(ctx.runId).toMatch(uuidV4Regex);
    });

    it("调用 1000 次应全部生成唯一 runId（无碰撞）", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const ctx = createRunContext(new AbortController().signal);
        ids.add(ctx.runId);
      }
      expect(ids.size).toBe(1000);
    });
  });

  // ── ancestry ──

  describe("ancestry", () => {
    it("根的 ancestry 应为仅包含自身 runId 的数组", () => {
      const explicitId = "root-001";
      const ctx = createRunContext(
        new AbortController().signal,
        explicitId,
      );

      expect(ctx.ancestry).toEqual([explicitId]);
      expect(ctx.ancestry.length).toBe(1);
      expect(ctx.ancestry[0]).toBe(ctx.runId);
    });

    it("自动生成的 runId 应与 ancestry[0] 一致", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(ctx.ancestry[0]).toBe(ctx.runId);
      expect(ctx.ancestry.length).toBe(1);
    });
  });

  // ── signal ──

  describe("signal", () => {
    it("应正确存储传入的 AbortSignal", () => {
      const controller = new AbortController();
      const ctx = createRunContext(controller.signal);

      expect(ctx.signal).toBe(controller.signal);
      expect(ctx.signal.aborted).toBe(false);

      controller.abort();
      expect(ctx.signal.aborted).toBe(true);
    });

    it("已中止的 signal 应反映在上下文中", () => {
      const controller = new AbortController();
      controller.abort();

      const ctx = createRunContext(controller.signal);

      expect(ctx.signal.aborted).toBe(true);
    });
  });

  // ── Immutability ──

  describe("Object.freeze 不可变性", () => {
    it("Object.isFrozen 应为 true", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it("禁止修改 runId（严格模式下抛 TypeError）", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(() => {
        (ctx as { runId: string }).runId = "hijacked";
      }).toThrow(TypeError);
    });

    it("禁止修改 ancestry（严格模式下抛 TypeError）", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(() => {
        (ctx as { ancestry: string[] }).ancestry = ["evil"];
      }).toThrow(TypeError);
    });

    it("禁止修改 signal（严格模式下抛 TypeError）", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(() => {
        (
          ctx as { signal: AbortSignal }
        ).signal = new AbortController().signal;
      }).toThrow(TypeError);
    });

    it("禁止添加新属性（严格模式下抛 TypeError）", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctx as any).extraField = "should not be allowed";
      }).toThrow(TypeError);
    });

    it("禁止删除属性（严格模式下抛 TypeError）", () => {
      const ctx = createRunContext(new AbortController().signal);

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (ctx as any).runId;
      }).toThrow(TypeError);
    });
  });

  // ── Type check ──

  describe("类型检查", () => {
    it("返回值应满足 RunContext 接口", () => {
      const ctx: RunContext = createRunContext(
        new AbortController().signal,
        "type-check",
      );

      expect(typeof ctx.runId).toBe("string");
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(Array.isArray(ctx.ancestry)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// createChildContext() — 子上下文
// ═══════════════════════════════════════════════════════

describe("createChildContext", () => {
  // ── runId ──

  describe("runId", () => {
    it("应自动生成唯一的子 runId", () => {
      const parent = createRunContext(new AbortController().signal, "parent");
      const child = createChildContext(parent);

      expect(child.runId).not.toBe(parent.runId);
      expect(child.runId).toBeTruthy();

      const uuidV4Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(child.runId).toMatch(uuidV4Regex);
    });

    it("应接受显式传入的 childRunId", () => {
      const parent = createRunContext(new AbortController().signal, "parent");
      const child = createChildContext(parent, "child-001");

      expect(child.runId).toBe("child-001");
    });

    it("同一父节点创建两个子节点应有不同的 runId", () => {
      const parent = createRunContext(new AbortController().signal, "p");
      const child1 = createChildContext(parent);
      const child2 = createChildContext(parent);

      expect(child1.runId).not.toBe(child2.runId);
    });
  });

  // ── ancestry ──

  describe("ancestry", () => {
    it("子 context 的 ancestry 应正确追加父 runId", () => {
      const parent = createRunContext(
        new AbortController().signal,
        "root-parent",
      );
      const child = createChildContext(parent, "child-node");

      expect(child.ancestry).toEqual(["root-parent", "child-node"]);
      expect(child.ancestry.length).toBe(2);
      expect(child.ancestry[0]).toBe(parent.runId);
      expect(child.ancestry[child.ancestry.length - 1]).toBe(child.runId);
    });

    it("自动生成的 childRunId 应正确出现在 ancestry 末尾", () => {
      const parent = createRunContext(new AbortController().signal, "p");
      const child = createChildContext(parent);

      expect(child.ancestry[0]).toBe("p");
      expect(child.ancestry[1]).toBe(child.runId);
      expect(child.ancestry.length).toBe(2);
    });

    it("父 context 的 ancestry 在创建子 context 后不应被修改", () => {
      const parent = createRunContext(
        new AbortController().signal,
        "original-root",
      );
      const parentAncestryBefore = [...parent.ancestry];

      createChildContext(parent, "child");
      createChildContext(parent, "child2");

      expect(parent.ancestry).toEqual(parentAncestryBefore);
      expect(parent.ancestry.length).toBe(1);
    });
  });

  // ── Deep ancestry chain ──

  describe("深层 ancestry 链（3+ 级别）", () => {
    it("3 级链路应正确记录完整运行树", () => {
      const root = createRunContext(
        new AbortController().signal,
        "root",
      );
      const agent = createChildContext(root, "agent");
      const tool = createChildContext(agent, "tool");

      // root: [root]
      expect(root.ancestry).toEqual(["root"]);
      // agent: [root, agent]
      expect(agent.ancestry).toEqual(["root", "agent"]);
      // tool: [root, agent, tool]
      expect(tool.ancestry).toEqual(["root", "agent", "tool"]);
    });

    it("5 级深度链路应正确追加", () => {
      const level1 = createRunContext(
        new AbortController().signal,
        "L1",
      );
      const level2 = createChildContext(level1, "L2");
      const level3 = createChildContext(level2, "L3");
      const level4 = createChildContext(level3, "L4");
      const level5 = createChildContext(level4, "L5");

      expect(level1.ancestry).toEqual(["L1"]);
      expect(level2.ancestry).toEqual(["L1", "L2"]);
      expect(level3.ancestry).toEqual(["L1", "L2", "L3"]);
      expect(level4.ancestry).toEqual(["L1", "L2", "L3", "L4"]);
      expect(level5.ancestry).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    });

    it("分枝链路：同一节点创建多个子节点，各自 ancestry 独立", () => {
      const root = createRunContext(
        new AbortController().signal,
        "root",
      );
      const branchA = createChildContext(root, "A");
      const branchB = createChildContext(root, "B");

      // branchA 的子节点
      const branchAChild = createChildContext(branchA, "A1");

      // branchB 的子节点
      const branchBChild = createChildContext(branchB, "B1");

      expect(branchAChild.ancestry).toEqual(["root", "A", "A1"]);
      expect(branchBChild.ancestry).toEqual(["root", "B", "B1"]);

      // 两条分支互不影响
      expect(branchAChild.ancestry).not.toEqual(branchBChild.ancestry);
    });

    it("浅拷贝：每个节点的 ancestry 是独立的数组引用", () => {
      const root = createRunContext(
        new AbortController().signal,
        "root",
      );
      const child = createChildContext(root, "child");

      // 验证是不同引用
      expect(root.ancestry).not.toBe(child.ancestry);

      // 进一步验证：即使引用不同，内容也不同（长度不同）
      expect(root.ancestry.length).toBe(1);
      expect(child.ancestry.length).toBe(2);
    });
  });

  // ── signal 继承 ──

  describe("signal 继承", () => {
    it("子 context 应继承父 context 的 AbortSignal", () => {
      const controller = new AbortController();
      const root = createRunContext(controller.signal, "root");
      const child = createChildContext(root, "child");

      expect(child.signal).toBe(root.signal);
      expect(child.signal).toBe(controller.signal);
    });

    it("父信号中止后，子 context 的 signal 也应反映中止状态", () => {
      const controller = new AbortController();
      const root = createRunContext(controller.signal, "root");
      const child = createChildContext(root, "child");

      expect(child.signal.aborted).toBe(false);

      controller.abort();

      expect(root.signal.aborted).toBe(true);
      expect(child.signal.aborted).toBe(true);
    });

    it("深层链路中所有节点的 signal 应指向同一个 AbortSignal", () => {
      const controller = new AbortController();
      const root = createRunContext(controller.signal, "root");
      const agent = createChildContext(root, "agent");
      const tool = createChildContext(agent, "tool");

      expect(root.signal).toBe(controller.signal);
      expect(agent.signal).toBe(controller.signal);
      expect(tool.signal).toBe(controller.signal);

      controller.abort();
      expect(root.signal.aborted).toBe(true);
      expect(agent.signal.aborted).toBe(true);
      expect(tool.signal.aborted).toBe(true);
    });

    it("在子 context 中监听 signal abort 事件应正确触发", () => {
      const controller = new AbortController();
      const root = createRunContext(controller.signal, "root");
      const child = createChildContext(root, "child");

      let aborted = false;
      child.signal.addEventListener("abort", () => {
        aborted = true;
      });

      controller.abort();

      expect(aborted).toBe(true);
    });
  });

  // ── Ancestry 数组独立性 ──

  describe("ancestry 数组引用独立性", () => {
    it("子 context 的 ancestry 是独立数组（不共享引用）", () => {
      const parent = createRunContext(
        new AbortController().signal,
        "p",
      );
      const child = createChildContext(parent, "c");

      expect(parent.ancestry).not.toBe(child.ancestry);
    });

    it("父 context 的 ancestry 不应被可变方法暴露 — 基本验证", () => {
      const parent = createRunContext(
        new AbortController().signal,
        "p",
      );
      const child = createChildContext(parent, "c");

      // Object.freeze 是浅冻结：数组本身是冻结对象的属性，无法通过 parent.ancestry = ... 替换
      // 但数组元素是原始类型 string，不可变
      // 这里的重点是：createChildContext 使用 [...parent.ancestry, id] 创建新数组
      // 所以 child.ancestry 和 parent.ancestry 是完全独立的数组对象

      // 验证类型：两者都是数组
      expect(Array.isArray(parent.ancestry)).toBe(true);
      expect(Array.isArray(child.ancestry)).toBe(true);

      // 验证内容独立
      expect(parent.ancestry).toEqual(["p"]);
      expect(child.ancestry).toEqual(["p", "c"]);

      // 验证引用独立
      expect(parent.ancestry).not.toBe(child.ancestry);
    });
  });

  // ── Immutability ──

  describe("Object.freeze 不可变性", () => {
    it("子 context 的 Object.isFrozen 应为 true", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent);

      expect(Object.isFrozen(child)).toBe(true);
    });

    it("禁止修改子 context 的 runId", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent, "my-child");

      expect(() => {
        (child as { runId: string }).runId = "hijacked";
      }).toThrow(TypeError);
    });

    it("禁止修改子 context 的 ancestry", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent);

      expect(() => {
        (child as { ancestry: string[] }).ancestry = ["x"];
      }).toThrow(TypeError);
    });

    it("禁止修改子 context 的 signal", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent);

      expect(() => {
        (
          child as { signal: AbortSignal }
        ).signal = new AbortController().signal;
      }).toThrow(TypeError);
    });

    it("禁止向子 context 添加新属性", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent);

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (child as any).extra = "no";
      }).toThrow(TypeError);
    });

    it("禁止删除子 context 的属性", () => {
      const parent = createRunContext(new AbortController().signal);
      const child = createChildContext(parent);

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (child as any).runId;
      }).toThrow(TypeError);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 完整运行树场景
// ═══════════════════════════════════════════════════════

describe("运行树场景", () => {
  it("Chat → Agent → Tool → SubTool 4 级链路", () => {
    const controller = new AbortController();

    // 入口：Chat
    const chat = createRunContext(controller.signal, "chat-001");

    // Chat 调用 Agent
    const agent = createChildContext(chat, "agent-001");

    // Agent 调用 Tool
    const tool = createChildContext(agent, "tool-search-001");

    // Tool 调用 SubTool（深层调用链）
    const subTool = createChildContext(tool, "subtool-db-query-001");

    // 验证运行树
    expect(chat.ancestry).toEqual(["chat-001"]);
    expect(agent.ancestry).toEqual(["chat-001", "agent-001"]);
    expect(tool.ancestry).toEqual([
      "chat-001",
      "agent-001",
      "tool-search-001",
    ]);
    expect(subTool.ancestry).toEqual([
      "chat-001",
      "agent-001",
      "tool-search-001",
      "subtool-db-query-001",
    ]);

    // 所有节点共享同一个 signal
    expect(chat.signal).toBe(controller.signal);
    expect(agent.signal).toBe(controller.signal);
    expect(tool.signal).toBe(controller.signal);
    expect(subTool.signal).toBe(controller.signal);

    // 取消传播：中止 signal
    controller.abort();
    expect(chat.signal.aborted).toBe(true);
    expect(agent.signal.aborted).toBe(true);
    expect(tool.signal.aborted).toBe(true);
    expect(subTool.signal.aborted).toBe(true);
  });

  it("并发的两个 Agent 各自拥有独立的运行树", () => {
    const controller = new AbortController();
    const chat = createRunContext(controller.signal, "chat");

    const agentA = createChildContext(chat, "agent-A");
    const agentB = createChildContext(chat, "agent-B");

    const toolA1 = createChildContext(agentA, "tool-A1");
    const toolB1 = createChildContext(agentB, "tool-B1");

    // 独立运行树
    expect(toolA1.ancestry).toEqual(["chat", "agent-A", "tool-A1"]);
    expect(toolB1.ancestry).toEqual(["chat", "agent-B", "tool-B1"]);

    // 互不干扰
    expect(toolA1.ancestry).not.toEqual(toolB1.ancestry);
  });

  it("Tracing/Debug 可通过 ancestry 直接重建运行树", () => {
    const controller = new AbortController();
    const root = createRunContext(controller.signal, "trace-root");
    const level1 = createChildContext(root, "trace-L1");
    const level2 = createChildContext(level1, "trace-L2");

    // ancestry 数组可直接序列化为 JSON 用于 tracing
    const trace = JSON.stringify(level2.ancestry);
    const parsed: string[] = JSON.parse(trace);

    expect(parsed).toEqual(["trace-root", "trace-L1", "trace-L2"]);
    expect(parsed[0]).toBe("trace-root"); // 根节点
    expect(parsed[parsed.length - 1]).toBe("trace-L2"); // 当前节点
  });
});

// ═══════════════════════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════════════════════

describe("边界条件", () => {
  it("createChildContext 接受空的根 context（runId 为空字符串）", () => {
    const parent = createRunContext(new AbortController().signal, "");
    const child = createChildContext(parent, "child");

    expect(child.ancestry).toEqual(["", "child"]);
    expect(child.ancestry[0]).toBe("");
    expect(child.ancestry[1]).toBe("child");
  });

  it("大量子节点创建不出错", () => {
    const root = createRunContext(new AbortController().signal, "root");
    const children: RunContext[] = [];

    for (let i = 0; i < 100; i++) {
      children.push(createChildContext(root, `child-${i}`));
    }

    // 所有子节点的 runId 唯一
    const ids = new Set(children.map((c) => c.runId));
    expect(ids.size).toBe(100);

    // 所有子节点的 ancestry[0] 都是 "root"
    for (const child of children) {
      expect(child.ancestry[0]).toBe("root");
      expect(child.ancestry.length).toBe(2);
    }
  });

  it("已冻结的父 context 传入 createChildContext 不应抛异常", () => {
    const parent = createRunContext(new AbortController().signal, "p");

    // parent 已是 frozen
    expect(Object.isFrozen(parent)).toBe(true);

    // 创建子 context 应正常工作
    expect(() => createChildContext(parent, "c")).not.toThrow();
  });
});
