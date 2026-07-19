// Blackboard 单元测试 — 共享上下文存储与多Agent协作版本控制
import { describe, it, expect, beforeEach } from "vitest";
import { Blackboard } from "../blackboard.js";

describe("Blackboard", () => {
  let bb: Blackboard;

  beforeEach(() => {
    bb = new Blackboard();
  });

  // =========================================================================
  // write
  // =========================================================================
  describe("write", () => {
    it("返回包含正确字段的 BlackboardEntry", () => {
      const entry = bb.write("task", { status: "done" }, "agent-1", {
        description: "任务结果",
        tags: ["result"],
      });

      expect(entry.key).toBe("task");
      expect(entry.value).toEqual({ status: "done" });
      expect(entry.writtenBy).toBe("agent-1");
      expect(entry.version).toBe(1);
      expect(entry.metadata).toEqual({ description: "任务结果", tags: ["result"] });
    });

    it("timestamp 为 ISO 8601 字符串", () => {
      const before = new Date().toISOString();
      const entry = bb.write("k", "v", "a");
      const after = new Date().toISOString();

      expect(entry.timestamp).toBeTruthy();
      // 验证是合法的 ISO 字符串并能解析
      const parsed = new Date(entry.timestamp);
      expect(parsed.toISOString()).toBe(entry.timestamp);
      // 验证时间戳在调用前后之间
      expect(entry.timestamp >= before).toBe(true);
      expect(entry.timestamp <= after).toBe(true);
    });

    it("首次写入 version 为 1", () => {
      const entry = bb.write("key", "value", "agent");
      expect(entry.version).toBe(1);
    });

    it("覆写时自动递增版本号 (v1 → v2)", () => {
      bb.write("key", "first", "agent");
      const entry = bb.write("key", "second", "agent");
      expect(entry.version).toBe(2);
    });

    it("多次覆写版本号持续递增", () => {
      bb.write("key", "v1", "agent");
      bb.write("key", "v2", "agent");
      bb.write("key", "v3", "agent");
      const entry = bb.write("key", "v4", "agent");
      expect(entry.version).toBe(4);
    });

    it("不同 key 独立计数", () => {
      bb.write("a", "v1", "agent");
      bb.write("a", "v2", "agent");
      const entryB = bb.write("b", "first", "agent");
      expect(entryB.version).toBe(1);
    });

    it("metadata 可选 — 不传时为 undefined", () => {
      const entry = bb.write("key", "value", "agent");
      expect(entry.metadata).toBeUndefined();
    });

    it("存储各类值类型 — string / number / object / array / null", () => {
      expect(bb.write("s", "hello", "a").value).toBe("hello");
      expect(bb.write("n", 42, "a").value).toBe(42);
      expect(bb.write("o", { x: 1 }, "a").value).toEqual({ x: 1 });
      expect(bb.write("arr", [1, 2, 3], "a").value).toEqual([1, 2, 3]);
      expect(bb.write("nu", null, "a").value).toBeNull();
    });
  });

  // =========================================================================
  // read
  // =========================================================================
  describe("read", () => {
    it("返回已存在 key 的值", () => {
      bb.write("name", "Alice", "agent-1");
      expect(bb.read("name")).toBe("Alice");
    });

    it("不存在的 key 返回 undefined", () => {
      expect(bb.read("nonexistent")).toBeUndefined();
    });

    it("覆写后返回最新值", () => {
      bb.write("key", "old", "agent");
      bb.write("key", "new", "agent");
      expect(bb.read("key")).toBe("new");
    });
  });

  // =========================================================================
  // getEntry
  // =========================================================================
  describe("getEntry", () => {
    it("返回完整 entry，包含 metadata 和 version", () => {
      bb.write("task", "done", "agent-x", { description: "desc" });
      const entry = bb.getEntry("task");
      expect(entry).toBeDefined();
      expect(entry!.key).toBe("task");
      expect(entry!.value).toBe("done");
      expect(entry!.writtenBy).toBe("agent-x");
      expect(entry!.version).toBe(1);
      expect(entry!.metadata).toEqual({ description: "desc" });
      expect(entry!.timestamp).toBeTruthy();
    });

    it("不存在的 key 返回 undefined", () => {
      expect(bb.getEntry("ghost")).toBeUndefined();
    });
  });

  // =========================================================================
  // has
  // =========================================================================
  describe("has", () => {
    it("存在的 key 返回 true", () => {
      bb.write("flag", true, "agent");
      expect(bb.has("flag")).toBe(true);
    });

    it("不存在的 key 返回 false", () => {
      expect(bb.has("nothing")).toBe(false);
    });

    it("删除后返回 false", () => {
      bb.write("temp", "x", "agent");
      expect(bb.has("temp")).toBe(true);
      bb.delete("temp", "agent");
      expect(bb.has("temp")).toBe(false);
    });
  });

  // =========================================================================
  // snapshot
  // =========================================================================
  describe("snapshot", () => {
    it("无条目时返回空对象", () => {
      expect(bb.snapshot()).toEqual({});
    });

    it("返回所有当前值构成的对象", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      expect(bb.snapshot()).toEqual({ a: 1, b: 2 });
    });

    it("覆写后反映最新值", () => {
      bb.write("key", "old", "agent");
      bb.write("key", "new", "agent");
      expect(bb.snapshot()).toEqual({ key: "new" });
    });

    it("返回新对象而非内部引用", () => {
      bb.write("k", "v", "a");
      const snap1 = bb.snapshot();
      snap1.k = "mutated";
      expect(bb.read("k")).toBe("v");
    });
  });

  // =========================================================================
  // entriesByAgent
  // =========================================================================
  describe("entriesByAgent", () => {
    it("返回指定 agent 的所有条目", () => {
      bb.write("a", 1, "alice");
      bb.write("b", 2, "alice");
      bb.write("c", 3, "bob");

      const aliceEntries = bb.entriesByAgent("alice");
      expect(aliceEntries).toHaveLength(2);
      expect(aliceEntries.map((e) => e.key)).toEqual(["a", "b"]);
    });

    it("无匹配时返回空数组", () => {
      bb.write("x", 1, "alice");
      expect(bb.entriesByAgent("bob")).toEqual([]);
    });

    it("包含历史版本（覆写产生的旧版本）", () => {
      bb.write("shared", "v1", "alice");
      bb.write("shared", "v2", "alice");
      bb.write("shared", "v3", "alice");

      const history = bb.entriesByAgent("alice");
      expect(history).toHaveLength(3);
      expect(history.map((e) => e.version)).toEqual([1, 2, 3]);
      expect(history.map((e) => e.value)).toEqual(["v1", "v2", "v3"]);
    });
  });

  // =========================================================================
  // getHistory
  // =========================================================================
  describe("getHistory", () => {
    it("按写入顺序返回所有版本", () => {
      bb.write("key", "v1", "agent");
      bb.write("key", "v2", "agent");
      bb.write("key", "v3", "agent");

      const history = bb.getHistory("key");
      expect(history).toHaveLength(3);
      expect(history.map((e) => e.version)).toEqual([1, 2, 3]);
    });

    it("未知 key 返回空数组", () => {
      expect(bb.getHistory("unknown")).toEqual([]);
    });

    it("删除后仍保留历史", () => {
      bb.write("key", "v1", "agent");
      bb.write("key", "v2", "agent");
      bb.delete("key", "agent");

      expect(bb.getHistory("key")).toHaveLength(2);
    });

    it("不同 key 的历史隔离", () => {
      bb.write("a", "a1", "agent");
      bb.write("b", "b1", "agent");
      bb.write("a", "a2", "agent");

      expect(bb.getHistory("a")).toHaveLength(2);
      expect(bb.getHistory("b")).toHaveLength(1);
    });
  });

  // =========================================================================
  // delete
  // =========================================================================
  describe("delete", () => {
    it("写入者可以删除自己的条目，返回 true", () => {
      bb.write("data", "secret", "alice");
      expect(bb.delete("data", "alice")).toBe(true);
    });

    it("删除后 key 不再可读", () => {
      bb.write("data", "secret", "alice");
      bb.delete("data", "alice");
      expect(bb.read("data")).toBeUndefined();
    });

    it("不同 agent 无法删除他人条目，返回 false", () => {
      bb.write("data", "secret", "alice");
      expect(bb.delete("data", "bob")).toBe(false);
      expect(bb.read("data")).toBe("secret"); // 数据仍在
    });

    it("删除不存在的 key 返回 false", () => {
      expect(bb.delete("ghost", "anyone")).toBe(false);
    });
  });

  // =========================================================================
  // keys
  // =========================================================================
  describe("keys", () => {
    it("初始为空数组", () => {
      expect(bb.keys()).toEqual([]);
    });

    it("写入后包含所有当前 key", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      expect(bb.keys()).toEqual(expect.arrayContaining(["a", "b"]));
      expect(bb.keys()).toHaveLength(2);
    });

    it("删除后 key 消失", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.delete("a", "agent");
      expect(bb.keys()).toEqual(["b"]);
    });

    it("覆写不重复 key", () => {
      bb.write("x", 1, "agent");
      bb.write("x", 2, "agent");
      expect(bb.keys()).toEqual(["x"]);
    });
  });

  // =========================================================================
  // size
  // =========================================================================
  describe("size", () => {
    it("初始为 0", () => {
      expect(bb.size).toBe(0);
    });

    it("写入后递增", () => {
      bb.write("a", 1, "agent");
      expect(bb.size).toBe(1);
      bb.write("b", 2, "agent");
      expect(bb.size).toBe(2);
    });

    it("覆写不改变 size", () => {
      bb.write("a", 1, "agent");
      bb.write("a", 2, "agent");
      expect(bb.size).toBe(1);
    });

    it("删除后递减", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.delete("a", "agent");
      expect(bb.size).toBe(1);
    });

    it("clear 后归零", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.clear();
      expect(bb.size).toBe(0);
    });
  });

  // =========================================================================
  // historyCount
  // =========================================================================
  describe("historyCount", () => {
    it("初始为 0", () => {
      expect(bb.historyCount).toBe(0);
    });

    it("计入所有版本（含覆写产生的历史）", () => {
      bb.write("key", "v1", "agent");
      expect(bb.historyCount).toBe(1);
      bb.write("key", "v2", "agent");
      expect(bb.historyCount).toBe(2);
      bb.write("key", "v3", "agent");
      expect(bb.historyCount).toBe(3);
    });

    it("不同 key 的写入都计入", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.write("c", 3, "agent");
      expect(bb.historyCount).toBe(3);
    });

    it("删除不减少历史计数", () => {
      bb.write("key", "v1", "agent");
      bb.write("key", "v2", "agent");
      expect(bb.historyCount).toBe(2);
      bb.delete("key", "agent");
      expect(bb.historyCount).toBe(2); // 历史保留
    });

    it("clear 后归零", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.clear();
      expect(bb.historyCount).toBe(0);
    });
  });

  // =========================================================================
  // serialize
  // =========================================================================
  describe("serialize", () => {
    it("返回 snapshot（当前值对象）", () => {
      bb.write("x", 10, "agent");
      bb.write("y", 20, "agent");
      expect(bb.serialize()).toEqual({ x: 10, y: 20 });
    });

    it("空 Blackboard 序列化为空对象", () => {
      expect(bb.serialize()).toEqual({});
    });

    it("与 snapshot 返回一致", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      expect(bb.serialize()).toEqual(bb.snapshot());
    });
  });

  // =========================================================================
  // toContextString
  // =========================================================================
  describe("toContextString", () => {
    it("空 Blackboard 返回 '(Blackboard 为空)'", () => {
      expect(bb.toContextString()).toBe("(Blackboard 为空)");
    });

    it("包含 key / value / agent / version", () => {
      bb.write("task", "完成", "分析师");
      const ctx = bb.toContextString();

      expect(ctx).toContain("Blackboard");
      expect(ctx).toContain("task");
      expect(ctx).toContain("完成");
      expect(ctx).toContain("分析师");
      expect(ctx).toContain("v1");
    });

    it("多个条目时每行一条", () => {
      bb.write("a", "值A", "agent-1");
      bb.write("b", "值B", "agent-2");
      const ctx = bb.toContextString();

      expect(ctx).toContain("- **a**");
      expect(ctx).toContain("- **b**");
      expect(ctx).toContain("值A");
      expect(ctx).toContain("值B");
      expect(ctx).toContain("agent-1");
      expect(ctx).toContain("agent-2");
    });

    it("对象值被 JSON.stringify 序列化", () => {
      bb.write("obj", { x: 1, y: 2 }, "agent");
      const ctx = bb.toContextString();
      expect(ctx).toContain('{"x":1,"y":2}');
    });

    it("字符串值不会被额外引号包裹", () => {
      bb.write("msg", "hello world", "agent");
      const ctx = bb.toContextString();
      // String values are used directly, not re-serialized
      expect(ctx).toContain("hello world");
      expect(ctx).not.toContain('"hello world"');
    });

    it("值超过 300 字符时截断", () => {
      const longValue = "x".repeat(500);
      bb.write("long", longValue, "agent");
      const ctx = bb.toContextString();

      // The substring(0, 300) is applied to the value display
      // The entry line should contain at most 300 chars of the value
      expect(ctx.length).toBeLessThan(500);
      // Should still contain the key
      expect(ctx).toContain("**long**");
    });

    it("null 值正常序列化", () => {
      bb.write("empty", null, "agent");
      const ctx = bb.toContextString();
      expect(ctx).toContain("null");
    });

    it("number 值正常序列化", () => {
      bb.write("count", 42, "agent");
      const ctx = bb.toContextString();
      expect(ctx).toContain("42");
    });
  });

  // =========================================================================
  // clear
  // =========================================================================
  describe("clear", () => {
    it("移除所有条目", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.clear();
      expect(bb.size).toBe(0);
      expect(bb.keys()).toEqual([]);
      expect(bb.snapshot()).toEqual({});
    });

    it("重置 size 为 0", () => {
      bb.write("a", 1, "agent");
      bb.write("b", 2, "agent");
      bb.write("c", 3, "agent");
      bb.clear();
      expect(bb.size).toBe(0);
    });

    it("重置 historyCount 为 0", () => {
      bb.write("a", 1, "agent");
      bb.write("a", 2, "agent");
      bb.write("a", 3, "agent");
      bb.clear();
      expect(bb.historyCount).toBe(0);
    });

    it("clear 后所有查询返回空/undefined", () => {
      bb.write("x", 1, "agent");
      bb.clear();
      expect(bb.read("x")).toBeUndefined();
      expect(bb.has("x")).toBe(false);
      expect(bb.getEntry("x")).toBeUndefined();
      expect(bb.getHistory("x")).toEqual([]);
    });
  });

  // =========================================================================
  // Version Control — 覆写版本号
  // =========================================================================
  describe("版本控制", () => {
    it("覆写同一 key 正确递增版本号", () => {
      const e1 = bb.write("shared", 1, "agent");
      expect(e1.version).toBe(1);

      const e2 = bb.write("shared", 2, "agent");
      expect(e2.version).toBe(2);

      const e3 = bb.write("shared", 3, "agent");
      expect(e3.version).toBe(3);
    });

    it("不同 agent 覆写也递增版本号", () => {
      bb.write("shared", "alice-data", "alice");
      const bobEntry = bb.write("shared", "bob-data", "bob");
      expect(bobEntry.version).toBe(2);
    });

    it("getHistory 返回的版本序列验证版本递增", () => {
      bb.write("k", "a", "agent");
      bb.write("k", "b", "agent");
      bb.write("k", "c", "agent");

      const versions = bb.getHistory("k").map((e) => e.version);
      expect(versions).toEqual([1, 2, 3]);
    });

    it("删除后重新写入版本号重置为 1（delete 移除 entries，prevEntry 为 undefined）", () => {
      bb.write("key", "v1", "agent");
      bb.write("key", "v2", "agent");
      bb.delete("key", "agent");

      // 重新写入 — delete 清除了 entries 中的引用，prevEntry 为 undefined，
      // 因此 version 重置为 1（(undefined?.version ?? 0) + 1 = 1）
      const entry = bb.write("key", "v3", "agent");
      expect(entry.version).toBe(1);

      // 历史中仍然保留了所有版本（delete 不清理 history）
      expect(bb.getHistory("key")).toHaveLength(3);
    });

    it("历史记录完整保留每次写入的时间戳", () => {
      bb.write("log", "first", "agent");
      bb.write("log", "second", "agent");

      const history = bb.getHistory("log");
      expect(history).toHaveLength(2);
      expect(history[0].timestamp).toBeTruthy();
      expect(history[1].timestamp).toBeTruthy();
      // 时间戳按写入顺序递增
      expect(new Date(history[0].timestamp).getTime()).toBeLessThanOrEqual(
        new Date(history[1].timestamp).getTime(),
      );
    });
  });
});
