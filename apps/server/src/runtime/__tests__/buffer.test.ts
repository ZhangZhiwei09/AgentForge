// OutputBuffer 单元测试 — 纯输出缓冲，验证 append / getContent / clear / isEmpty
import { describe, it, expect } from "vitest";
import { OutputBuffer } from "../buffer.js";

describe("OutputBuffer", () => {
  // ═══════════════════════════════════════════════════════════════════
  // 初始状态
  // ═══════════════════════════════════════════════════════════════════
  describe("初始状态", () => {
    it("getContent 应返回空字符串（非 null / undefined）", () => {
      const buffer = new OutputBuffer();
      expect(buffer.getContent()).toBe("");
      expect(buffer.getContent()).not.toBeNull();
      expect(buffer.getContent()).not.toBeUndefined();
    });

    it("isEmpty 应为 true", () => {
      const buffer = new OutputBuffer();
      expect(buffer.isEmpty).toBe(true);
    });

    it("多次调用 getContent 应始终返回一致的空字符串", () => {
      const buffer = new OutputBuffer();
      expect(buffer.getContent()).toBe("");
      expect(buffer.getContent()).toBe("");
      expect(buffer.getContent()).toBe("");
    });

    it("多次调用 isEmpty 应始终返回 true", () => {
      const buffer = new OutputBuffer();
      expect(buffer.isEmpty).toBe(true);
      expect(buffer.isEmpty).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // append
  // ═══════════════════════════════════════════════════════════════════
  describe("append", () => {
    // ── 基本追加 ──
    describe("基本追加", () => {
      it("应追加单个字符串到缓冲区", () => {
        const buffer = new OutputBuffer();
        buffer.append("hello");
        expect(buffer.getContent()).toBe("hello");
      });

      it("追加后 isEmpty 应变为 false", () => {
        const buffer = new OutputBuffer();
        expect(buffer.isEmpty).toBe(true);
        buffer.append("x");
        expect(buffer.isEmpty).toBe(false);
      });

      it("追加后 getContent 应反映最新内容", () => {
        const buffer = new OutputBuffer();
        buffer.append("first");
        expect(buffer.getContent()).toBe("first");
        buffer.append(" second");
        expect(buffer.getContent()).toBe("first second");
      });
    });

    // ── 多次追加 ──
    describe("多次追加", () => {
      it("多次 append 应按顺序累积全部内容", () => {
        const buffer = new OutputBuffer();

        const tokens = ["Hello", ", ", "World", "!", " How", " are", " you", "?"];
        const expected = "Hello, World! How are you?";

        for (const token of tokens) {
          buffer.append(token);
        }

        expect(buffer.getContent()).toBe(expected);
      });

      it("多次追加后 isEmpty 应为 false（非仅最后一个 token 有效）", () => {
        const buffer = new OutputBuffer();
        buffer.append("a");
        buffer.append("b");
        buffer.append("c");
        expect(buffer.isEmpty).toBe(false);
        expect(buffer.getContent()).toBe("abc");
      });

      it("100 次 1 字符追加应等于一次 100 字符追加", () => {
        const incremental = new OutputBuffer();
        for (let i = 0; i < 100; i++) {
          incremental.append("x");
        }

        const direct = new OutputBuffer();
        direct.append("x".repeat(100));

        expect(incremental.getContent()).toBe(direct.getContent());
        expect(incremental.getContent().length).toBe(100);
      });
    });

    // ── 追加空字符串 ──
    describe("追加空字符串", () => {
      it("追加空字符串不应改变缓冲区内容", () => {
        const buffer = new OutputBuffer();
        buffer.append("hello");
        const before = buffer.getContent();
        buffer.append("");
        expect(buffer.getContent()).toBe(before);
        expect(buffer.getContent()).toBe("hello");
      });

      it("追加空字符串不应改变 isEmpty 状态", () => {
        const empty = new OutputBuffer();
        expect(empty.isEmpty).toBe(true);
        empty.append("");
        expect(empty.isEmpty).toBe(true);

        const nonEmpty = new OutputBuffer();
        nonEmpty.append("data");
        expect(nonEmpty.isEmpty).toBe(false);
        nonEmpty.append("");
        expect(nonEmpty.isEmpty).toBe(false);
      });

      it("多次追加空字符串后缓冲区内容不变", () => {
        const buffer = new OutputBuffer();
        buffer.append("content");
        buffer.append("");
        buffer.append("");
        buffer.append("");
        expect(buffer.getContent()).toBe("content");
      });

      it("仅追加空字符串时，getContent 仍返回空字符串", () => {
        const buffer = new OutputBuffer();
        buffer.append("");
        buffer.append("");
        expect(buffer.getContent()).toBe("");
        expect(buffer.isEmpty).toBe(true);
      });
    });

    // ── 大文本 ──
    describe("大文本处理", () => {
      it("追加 100K+ 字符不应崩溃", () => {
        const buffer = new OutputBuffer();
        const chunk = "x".repeat(100_000);
        buffer.append(chunk);
        expect(buffer.getContent().length).toBe(100_000);
        expect(buffer.isEmpty).toBe(false);
      });

      it("追加 200K 字符不应崩溃", () => {
        const buffer = new OutputBuffer();
        const chunk = "x".repeat(200_000);
        buffer.append(chunk);
        expect(buffer.getContent().length).toBe(200_000);
      });

      it("多次追加中等大小 token 累计超过 100K 不应崩溃", () => {
        const buffer = new OutputBuffer();
        for (let i = 0; i < 1000; i++) {
          buffer.append("x".repeat(100));
        }
        expect(buffer.getContent().length).toBe(100_000);
        expect(buffer.isEmpty).toBe(false);
      });

      it("追加大文本后 getContent 应返回完整内容（验证首尾字符）", () => {
        const buffer = new OutputBuffer();
        const prefix = "START:";
        const body = "A".repeat(50_000);
        const suffix = ":END";
        buffer.append(prefix + body + suffix);

        const result = buffer.getContent();
        expect(result.slice(0, 6)).toBe("START:");
        expect(result.slice(-4)).toBe(":END");
        expect(result.length).toBe(6 + 50_000 + 4);
      });
    });

    // ── 边界情况 ──
    describe("边界情况", () => {
      it("追加含换行符的字符串", () => {
        const buffer = new OutputBuffer();
        buffer.append("line1\nline2\nline3");
        expect(buffer.getContent()).toBe("line1\nline2\nline3");
        expect(buffer.isEmpty).toBe(false);
      });

      it("追加含 Unicode 字符的字符串", () => {
        const buffer = new OutputBuffer();
        buffer.append("你好，世界！🎉");
        expect(buffer.getContent()).toBe("你好，世界！🎉");
      });

      it("追加含制表符的字符串", () => {
        const buffer = new OutputBuffer();
        buffer.append("col1\tcol2\tcol3");
        expect(buffer.getContent()).toBe("col1\tcol2\tcol3");
      });

      it("追加含零宽字符的字符串", () => {
        const buffer = new OutputBuffer();
        const zwsp = "​"; // zero-width space
        buffer.append("a" + zwsp + "b");
        expect(buffer.getContent()).toBe("a" + zwsp + "b");
        expect(buffer.isEmpty).toBe(false);
        expect(buffer.getContent().length).toBe(3);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getContent
  // ═══════════════════════════════════════════════════════════════════
  describe("getContent", () => {
    it("应返回累积的完整内容", () => {
      const buffer = new OutputBuffer();
      buffer.append("Hello, ");
      buffer.append("World!");
      expect(buffer.getContent()).toBe("Hello, World!");
    });

    it("应返回字符串类型（非 null / undefined）", () => {
      const buffer = new OutputBuffer();
      expect(typeof buffer.getContent()).toBe("string");

      buffer.append("data");
      expect(typeof buffer.getContent()).toBe("string");
    });

    it("getContent 不应修改缓冲区状态", () => {
      const buffer = new OutputBuffer();
      buffer.append("hello");
      const before = buffer.getContent();
      buffer.getContent(); // call again
      buffer.getContent(); // call again
      expect(buffer.getContent()).toBe(before);
      expect(buffer.isEmpty).toBe(false);
    });

    it("clear 后 getContent 应返回空字符串", () => {
      const buffer = new OutputBuffer();
      buffer.append("data");
      buffer.clear();
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // clear
  // ═══════════════════════════════════════════════════════════════════
  describe("clear", () => {
    it("应清空已填充的缓冲区", () => {
      const buffer = new OutputBuffer();
      buffer.append("hello");
      expect(buffer.isEmpty).toBe(false);

      buffer.clear();
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);
    });

    it("clear 后 append 应在干净缓冲区上正常工作", () => {
      const buffer = new OutputBuffer();
      buffer.append("first session");
      buffer.clear();
      buffer.append("second session");
      expect(buffer.getContent()).toBe("second session");
      expect(buffer.isEmpty).toBe(false);
    });

    it("clear → append → clear → append 多次循环应正常工作", () => {
      const buffer = new OutputBuffer();

      const sessions = ["session-1", "session-2", "session-3"];
      for (const session of sessions) {
        buffer.append(session);
        expect(buffer.getContent()).toBe(session);
        expect(buffer.isEmpty).toBe(false);
        buffer.clear();
        expect(buffer.getContent()).toBe("");
        expect(buffer.isEmpty).toBe(true);
      }
    });

    it("对已空缓冲区调用 clear 应为幂等操作", () => {
      const buffer = new OutputBuffer();
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);

      buffer.clear();
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);

      buffer.clear();
      buffer.clear();
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);
    });

    it("clear 后多次调用 clear 仍保持幂等", () => {
      const buffer = new OutputBuffer();
      buffer.append("data");
      buffer.clear(); // first clear
      buffer.clear(); // second clear on empty
      buffer.clear(); // third clear on empty
      expect(buffer.getContent()).toBe("");
      expect(buffer.isEmpty).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // isEmpty
  // ═══════════════════════════════════════════════════════════════════
  describe("isEmpty", () => {
    it("新建缓冲区应为空", () => {
      const buffer = new OutputBuffer();
      expect(buffer.isEmpty).toBe(true);
    });

    it("追加字符后应不为空", () => {
      const buffer = new OutputBuffer();
      buffer.append("a");
      expect(buffer.isEmpty).toBe(false);
    });

    it("clear 后再次为空", () => {
      const buffer = new OutputBuffer();
      buffer.append("data");
      buffer.clear();
      expect(buffer.isEmpty).toBe(true);
    });

    it("isEmpty 应返回布尔类型", () => {
      const buffer = new OutputBuffer();
      expect(typeof buffer.isEmpty).toBe("boolean");
      expect(buffer.isEmpty).toBe(true);

      buffer.append("x");
      expect(typeof buffer.isEmpty).toBe("boolean");
      expect(buffer.isEmpty).toBe(false);
    });

    it("isEmpty 不应修改缓冲区状态", () => {
      const buffer = new OutputBuffer();
      buffer.append("hello");

      expect(buffer.isEmpty).toBe(false);
      expect(buffer.isEmpty).toBe(false); // 再次调用
      expect(buffer.getContent()).toBe("hello"); // 内容不受影响
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 完整生命周期场景
  // ═══════════════════════════════════════════════════════════════════
  describe("完整生命周期", () => {
    it("应模拟流式输出：逐 token 追加 → 获取完整内容 → 清空 → 重用", () => {
      // 模拟 Chat 流式响应
      const chatBuffer = new OutputBuffer();

      // 第 1 轮对话
      const tokens1 = ["你好", "，", "请问", "有什么", "可以", "帮您", "？"];
      for (const token of tokens1) {
        chatBuffer.append(token);
      }
      expect(chatBuffer.getContent()).toBe("你好，请问有什么可以帮您？");

      chatBuffer.clear();
      expect(chatBuffer.isEmpty).toBe(true);

      // 第 2 轮对话
      const tokens2 = ["我", "想", "查询", "订单", "状态"];
      for (const token of tokens2) {
        chatBuffer.append(token);
      }
      expect(chatBuffer.getContent()).toBe("我想查询订单状态");
    });

    it("应模拟 AgentTrace：分步追加 → 获取 → 清空", () => {
      const traceBuffer = new OutputBuffer();

      // Step 1: 分类
      traceBuffer.append("[SAFETY] 安全审查通过\n");
      expect(traceBuffer.isEmpty).toBe(false);

      // Step 2: 规划
      traceBuffer.append("[PLAN] 查询知识库 → 生成回复\n");
      expect(traceBuffer.getContent()).toContain("SAFETY");
      expect(traceBuffer.getContent()).toContain("PLAN");

      // 获取完整 trace 后清空
      const fullTrace = traceBuffer.getContent();
      expect(typeof fullTrace).toBe("string");
      expect(fullTrace.length).toBeGreaterThan(0);

      traceBuffer.clear();
      expect(traceBuffer.getContent()).toBe("");
      expect(traceBuffer.isEmpty).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 多个 Buffer 实例隔离
  // ═══════════════════════════════════════════════════════════════════
  describe("实例隔离", () => {
    it("不同实例应相互独立", () => {
      const buffer1 = new OutputBuffer();
      const buffer2 = new OutputBuffer();

      buffer1.append("data-1");
      buffer2.append("data-2");

      expect(buffer1.getContent()).toBe("data-1");
      expect(buffer2.getContent()).toBe("data-2");
      expect(buffer1.getContent()).not.toBe(buffer2.getContent());
    });

    it("一个实例 clear 不应影响另一个实例", () => {
      const buffer1 = new OutputBuffer();
      const buffer2 = new OutputBuffer();

      buffer1.append("a");
      buffer2.append("b");

      buffer1.clear();

      expect(buffer1.getContent()).toBe("");
      expect(buffer1.isEmpty).toBe(true);
      expect(buffer2.getContent()).toBe("b");
      expect(buffer2.isEmpty).toBe(false);
    });
  });
});
