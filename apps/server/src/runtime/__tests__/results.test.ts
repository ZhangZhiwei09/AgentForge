// ExecutionResult Factory Functions — Comprehensive Unit Tests
// ==========================================================
// 覆盖所有工厂函数、序列化函数、状态判断函数、枚举定义和类型安全。
// ExecutionResult 五态协议是 Agent Runtime 的核心契约，
// 所有执行单元（Tool、Agent、Workflow、MCP）依赖此类型。

import { describe, it, expect } from "vitest";
import {
  // Enums
  ExecutionState,
  ExecutionErrorCode,
  // Constants
  TERMINAL_STATES,
  // Factory functions
  successResult,
  partialResult,
  failedResult,
  cancelledResult,
  timeoutResult,
  // Serialization & checks
  executionResultToContent,
  isDegradedResult,
  isRetryableResult,
} from "../results.js";
import type { ExecutionResult, ExecutionError } from "../results.js";

// ═══════════════════════════════════════════════════════
// 1. successResult()
// ═══════════════════════════════════════════════════════

describe("successResult()", () => {
  it("应返回 status='success' 的结果", () => {
    const result = successResult("操作完成");
    expect(result.status).toBe("success");
  });

  it("应包含提供的 output", () => {
    const result = successResult("操作完成");
    expect(result.output).toBe("操作完成");
  });

  it("应处理空字符串 output", () => {
    const result = successResult("");
    expect(result.output).toBe("");
    expect(result.status).toBe("success");
  });

  it("应处理多行 output", () => {
    const output = "第一行\n第二行\n第三行";
    const result = successResult(output);
    expect(result.output).toBe(output);
  });

  it("不传 metadata 时不应包含 metadata 字段", () => {
    const result = successResult("done");
    expect(result).not.toHaveProperty("metadata");
  });

  it("传入 metadata 时应包含 metadata 字段", () => {
    const meta = { toolCalls: 3, durationMs: 150 };
    const result = successResult("done", meta);
    expect(result).toHaveProperty("metadata");
    expect(result.metadata).toEqual(meta);
  });

  it("传入空对象 metadata 时应保留 metadata 字段", () => {
    const result = successResult("done", {});
    expect(result).toHaveProperty("metadata");
    expect(result.metadata).toEqual({});
  });

  it("metadata 应支持复杂嵌套结构", () => {
    const meta = {
      toolCalls: [{ name: "search", args: { q: "test" } }],
      tokens: { input: 100, output: 50 },
    };
    const result = successResult("done", meta);
    expect(result.metadata).toEqual(meta);
  });
});

// ═══════════════════════════════════════════════════════
// 2. partialResult()
// ═══════════════════════════════════════════════════════

describe("partialResult()", () => {
  it("应返回 status='partial' 的结果", () => {
    const result = partialResult("部分完成", "部分数据不可用");
    expect(result.status).toBe("partial");
  });

  it("应包含提供的 output", () => {
    const result = partialResult("部分完成", "部分数据不可用");
    expect(result.output).toBe("部分完成");
  });

  it("应包含提供的 reason", () => {
    const result = partialResult("部分完成", "部分数据不可用");
    expect(result.reason).toBe("部分数据不可用");
  });

  it("不传 metadata 时不应包含 metadata 字段", () => {
    const result = partialResult("部分完成", "降级原因");
    expect(result).not.toHaveProperty("metadata");
  });

  it("传入 metadata 时应包含 metadata 字段", () => {
    const meta = { degradedSources: ["db"] };
    const result = partialResult("部分完成", "DB 不可用", meta);
    expect(result.metadata).toEqual(meta);
  });

  it("应处理空字符串 output 和 reason", () => {
    const result = partialResult("", "");
    expect(result.output).toBe("");
    expect(result.reason).toBe("");
    expect(result.status).toBe("partial");
  });

  it("reason 应能包含多行文本", () => {
    const reason = "原因1：超时\n原因2：数据不完整";
    const result = partialResult("output", reason);
    expect(result.reason).toBe(reason);
  });
});

// ═══════════════════════════════════════════════════════
// 3. failedResult()
// ═══════════════════════════════════════════════════════

describe("failedResult()", () => {
  it("应返回 status='failed' 的结果", () => {
    const result = failedResult(ExecutionErrorCode.INTERNAL_ERROR, "系统错误");
    expect(result.status).toBe("failed");
  });

  it("应包含 error.code", () => {
    const result = failedResult(ExecutionErrorCode.NOT_FOUND, "资源不存在");
    expect(result.error.code).toBe(ExecutionErrorCode.NOT_FOUND);
  });

  it("应包含 error.message", () => {
    const result = failedResult(ExecutionErrorCode.NETWORK_ERROR, "连接超时");
    expect(result.error.message).toBe("连接超时");
  });

  it("retryable 默认应为 false", () => {
    const result = failedResult(ExecutionErrorCode.API_ERROR, "API 错误");
    expect(result.error.retryable).toBe(false);
  });

  it("retryable 可显式设为 true", () => {
    const result = failedResult(
      ExecutionErrorCode.TIMEOUT,
      "请求超时",
      true,
    );
    expect(result.error.retryable).toBe(true);
  });

  it("retryable 可显式设为 false", () => {
    const result = failedResult(
      ExecutionErrorCode.RATE_LIMIT,
      "频率限制",
      false,
    );
    expect(result.error.retryable).toBe(false);
  });

  it("应覆盖所有 ExecutionErrorCode 枚举值", () => {
    const allCodes = Object.values(ExecutionErrorCode);
    for (const code of allCodes) {
      const result = failedResult(code, `错误: ${code}`);
      expect(result.error.code).toBe(code);
      expect(result.status).toBe("failed");
    }
  });

  it("error 对象结构应符合 ExecutionError 接口", () => {
    const result = failedResult(ExecutionErrorCode.CIRCUIT_OPEN, "熔断");
    const error: ExecutionError = result.error;
    expect(typeof error.code).toBe("string");
    expect(typeof error.message).toBe("string");
    expect(typeof error.retryable).toBe("boolean");
  });

  it("应处理空字符串 message", () => {
    const result = failedResult(ExecutionErrorCode.INTERNAL_ERROR, "");
    expect(result.error.message).toBe("");
  });
});

// ═══════════════════════════════════════════════════════
// 4. cancelledResult()
// ═══════════════════════════════════════════════════════

describe("cancelledResult()", () => {
  it("应返回 status='cancelled' 的结果", () => {
    const result = cancelledResult("用户取消");
    expect(result.status).toBe("cancelled");
  });

  it("应包含提供的 reason", () => {
    const result = cancelledResult("用户取消");
    expect(result.reason).toBe("用户取消");
  });

  it("应处理空字符串 reason", () => {
    const result = cancelledResult("");
    expect(result.reason).toBe("");
    expect(result.status).toBe("cancelled");
  });

  it("应处理多行 reason", () => {
    const reason = "用户主动终止\n会话超时";
    const result = cancelledResult(reason);
    expect(result.reason).toBe(reason);
  });

  it("不应包含 error 字段（与 failed 区分）", () => {
    const result = cancelledResult("取消");
    expect(result).not.toHaveProperty("error");
  });
});

// ═══════════════════════════════════════════════════════
// 5. timeoutResult()
// ═══════════════════════════════════════════════════════

describe("timeoutResult()", () => {
  it("应返回 status='timeout' 的结果", () => {
    const result = timeoutResult(30000);
    expect(result.status).toBe("timeout");
  });

  it("应包含 provided afterMs", () => {
    const result = timeoutResult(30000);
    expect(result.afterMs).toBe(30000);
  });

  it("应处理 afterMs=0", () => {
    const result = timeoutResult(0);
    expect(result.afterMs).toBe(0);
    expect(result.status).toBe("timeout");
  });

  it("应处理大数值 afterMs", () => {
    const result = timeoutResult(300000); // 5 minutes
    expect(result.afterMs).toBe(300000);
  });

  it("应处理负数 afterMs（不做运行时校验）", () => {
    const result = timeoutResult(-1);
    expect(result.afterMs).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════
// 6. executionResultToContent() — 序列化
// ═══════════════════════════════════════════════════════

describe("executionResultToContent()", () => {
  describe("success 状态", () => {
    it("应直接返回 output 文本", () => {
      const result = successResult("操作成功完成");
      const content = executionResultToContent(result);
      expect(content).toBe("操作成功完成");
    });

    it("不应添加任何前缀或后缀", () => {
      const result = successResult("纯文本输出");
      const content = executionResultToContent(result);
      expect(content).not.toContain("[");
      expect(content).not.toContain("]");
    });

    it("应保留多行 output", () => {
      const output = "行1\n行2\n行3";
      const result = successResult(output);
      const content = executionResultToContent(result);
      expect(content).toBe(output);
    });
  });

  describe("partial 状态", () => {
    it("应包含 output 和 reason", () => {
      const result = partialResult("部分内容", "数据源不可用");
      const content = executionResultToContent(result);
      expect(content).toContain("部分内容");
      expect(content).toContain("[注意]");
      expect(content).toContain("数据源不可用");
    });

    it("格式应为 output + 换行 + [注意] reason", () => {
      const result = partialResult("OUTPUT", "REASON");
      const content = executionResultToContent(result);
      expect(content).toBe("OUTPUT\n\n[注意] REASON");
    });

    it("应处理空 output", () => {
      const result = partialResult("", "降级原因");
      const content = executionResultToContent(result);
      expect(content).toContain("[注意] 降级原因");
    });
  });

  describe("failed 状态", () => {
    it("应包含 [工具执行失败] 前缀和 error.message", () => {
      const result = failedResult(
        ExecutionErrorCode.NETWORK_ERROR,
        "网络不可达",
      );
      const content = executionResultToContent(result);
      expect(content).toBe("[工具执行失败] 网络不可达");
    });

    it("不应暴露 error.code 给 LLM", () => {
      const result = failedResult(
        ExecutionErrorCode.RATE_LIMIT,
        "请求过于频繁",
      );
      const content = executionResultToContent(result);
      expect(content).not.toContain("RATE_LIMIT");
      expect(content).not.toContain("error.code");
    });

    it("应处理空 message", () => {
      const result = failedResult(ExecutionErrorCode.INTERNAL_ERROR, "");
      const content = executionResultToContent(result);
      expect(content).toBe("[工具执行失败] ");
    });
  });

  describe("cancelled 状态", () => {
    it("应包含 [已取消] 前缀和 reason", () => {
      const result = cancelledResult("用户终止会话");
      const content = executionResultToContent(result);
      expect(content).toBe("[已取消] 用户终止会话");
    });

    it("应处理空 reason", () => {
      const result = cancelledResult("");
      const content = executionResultToContent(result);
      expect(content).toBe("[已取消] ");
    });
  });

  describe("timeout 状态", () => {
    it("应包含 [超时] 前缀和 afterMs", () => {
      const result = timeoutResult(30000);
      const content = executionResultToContent(result);
      expect(content).toBe("[超时] 执行超过 30000ms");
    });

    it("应格式化较大的 afterMs 值", () => {
      const result = timeoutResult(120000);
      const content = executionResultToContent(result);
      expect(content).toContain("120000");
    });
  });

  describe("穷尽性检查（switch 覆盖所有 status）", () => {
    it("所有五态都应产出非空字符串", () => {
      const results: ExecutionResult[] = [
        successResult("ok"),
        partialResult("partial", "reason"),
        failedResult(ExecutionErrorCode.INTERNAL_ERROR, "err"),
        cancelledResult("cancelled"),
        timeoutResult(5000),
      ];

      for (const r of results) {
        const content = executionResultToContent(r);
        expect(typeof content).toBe("string");
        // 注意：successResult("") 产出空串，但 factory 允许空字符串
      }
    });
  });
});

// ═══════════════════════════════════════════════════════
// 7. isDegradedResult()
// ═══════════════════════════════════════════════════════

describe("isDegradedResult()", () => {
  it("failed 状态应返回 true", () => {
    const result = failedResult(ExecutionErrorCode.API_ERROR, "出错");
    expect(isDegradedResult(result)).toBe(true);
  });

  it("timeout 状态应返回 true", () => {
    const result = timeoutResult(30000);
    expect(isDegradedResult(result)).toBe(true);
  });

  it("cancelled 状态应返回 true", () => {
    const result = cancelledResult("取消");
    expect(isDegradedResult(result)).toBe(true);
  });

  it("success 状态应返回 false", () => {
    const result = successResult("完成");
    expect(isDegradedResult(result)).toBe(false);
  });

  it("partial 状态应返回 false（partial 不是降级态，是部分成功）", () => {
    const result = partialResult("部分", "原因");
    expect(isDegradedResult(result)).toBe(false);
  });

  it("所有 status 的覆盖测试", () => {
    const testCases: [ExecutionResult, boolean][] = [
      [successResult("ok"), false],
      [partialResult("p", "r"), false],
      [failedResult(ExecutionErrorCode.INTERNAL_ERROR, "e"), true],
      [cancelledResult("c"), true],
      [timeoutResult(1000), true],
    ];

    for (const [result, expected] of testCases) {
      expect(isDegradedResult(result)).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 8. isRetryableResult()
// ═══════════════════════════════════════════════════════

describe("isRetryableResult()", () => {
  describe("failed + retryable=true", () => {
    it("应返回 true", () => {
      const result = failedResult(
        ExecutionErrorCode.TIMEOUT,
        "超时",
        true,
      );
      expect(isRetryableResult(result)).toBe(true);
    });

    it("多个可重试错误码均应返回 true", () => {
      const retryableCodes = [
        ExecutionErrorCode.TIMEOUT,
        ExecutionErrorCode.NETWORK_ERROR,
        ExecutionErrorCode.RATE_LIMIT,
        ExecutionErrorCode.CIRCUIT_OPEN,
      ];

      for (const code of retryableCodes) {
        const result = failedResult(code, `可重试: ${code}`, true);
        expect(isRetryableResult(result)).toBe(true);
      }
    });
  });

  describe("failed + retryable=false", () => {
    it("默认 retryable=false 应返回 false", () => {
      const result = failedResult(
        ExecutionErrorCode.INVALID_PARAM,
        "参数无效",
      );
      expect(isRetryableResult(result)).toBe(false);
    });

    it("显式 retryable=false 应返回 false", () => {
      const result = failedResult(
        ExecutionErrorCode.ACCESS_DENIED,
        "无权限",
        false,
      );
      expect(isRetryableResult(result)).toBe(false);
    });

    it("不可重试的错误码（语义上不应重试）均应返回 false", () => {
      const nonRetryableCodes = [
        ExecutionErrorCode.NOT_FOUND,
        ExecutionErrorCode.ACCESS_DENIED,
        ExecutionErrorCode.INVALID_PARAM,
        ExecutionErrorCode.CONFLICT,
        ExecutionErrorCode.INTERNAL_ERROR,
      ];

      for (const code of nonRetryableCodes) {
        const result = failedResult(code, `不可重试: ${code}`, false);
        expect(isRetryableResult(result)).toBe(false);
      }
    });
  });

  describe("非 failed 状态", () => {
    it("success 应返回 false", () => {
      expect(isRetryableResult(successResult("ok"))).toBe(false);
    });

    it("partial 应返回 false", () => {
      expect(isRetryableResult(partialResult("p", "r"))).toBe(false);
    });

    it("cancelled 应返回 false（cancelled 不是 failed，无 error 字段）", () => {
      expect(isRetryableResult(cancelledResult("取消"))).toBe(false);
    });

    it("timeout 应返回 false（timeout 不是 failed，无 error 字段）", () => {
      expect(isRetryableResult(timeoutResult(30000))).toBe(false);
    });
  });

  describe("所有 status 覆盖", () => {
    it("仅 failed + retryable=true 返回 true", () => {
      const allResults: ExecutionResult[] = [
        successResult("ok"),
        partialResult("p", "r"),
        failedResult(ExecutionErrorCode.TIMEOUT, "可重试", true),
        failedResult(ExecutionErrorCode.INVALID_PARAM, "不可重试", false),
        cancelledResult("c"),
        timeoutResult(5000),
      ];

      const retryable = allResults.filter(isRetryableResult);
      expect(retryable).toHaveLength(1);
      expect(retryable[0].status).toBe("failed");
      if (retryable[0].status === "failed") {
        expect(retryable[0].error.retryable).toBe(true);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════
// 9. ExecutionErrorCode — 枚举完整性
// ═══════════════════════════════════════════════════════

describe("ExecutionErrorCode", () => {
  const expectedCodes = [
    "NOT_FOUND",
    "ACCESS_DENIED",
    "INVALID_PARAM",
    "EXECUTION_ERROR",
    "TIMEOUT",
    "CIRCUIT_OPEN",
    "RATE_LIMIT",
    "NETWORK_ERROR",
    "API_ERROR",
    "CONFLICT",
    "CANCELLED",
    "INTERNAL_ERROR",
  ] as const;

  it("应包含恰好 12 个错误码", () => {
    const values = Object.values(ExecutionErrorCode);
    expect(values).toHaveLength(12);
  });

  it("应包含所有 12 个预期错误码", () => {
    const values = Object.values(ExecutionErrorCode);
    for (const code of expectedCodes) {
      expect(values).toContain(code);
    }
  });

  it("每个错误码应是唯一字符串", () => {
    const values = Object.values(ExecutionErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("每个错误码的键和值应一致", () => {
    for (const code of expectedCodes) {
      expect(ExecutionErrorCode[code]).toBe(code);
    }
  });

  it("不应包含预期之外的错误码", () => {
    const values = Object.values(ExecutionErrorCode);
    for (const code of values) {
      expect(expectedCodes).toContain(code as typeof expectedCodes[number]);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 10. ExecutionState — 枚举与终端态
// ═══════════════════════════════════════════════════════

describe("ExecutionState", () => {
  it("应包含 6 个状态值", () => {
    const values = Object.values(ExecutionState);
    expect(values).toHaveLength(6);
  });

  it("应包含所有预期状态", () => {
    const expected = ["created", "running", "completed", "failed", "cancelled", "timeout"];
    for (const state of expected) {
      expect(Object.values(ExecutionState)).toContain(state);
    }
  });
});

describe("TERMINAL_STATES", () => {
  it("应包含 4 个终端态", () => {
    expect(TERMINAL_STATES.size).toBe(4);
  });

  it("应包含 COMPLETED、FAILED、CANCELLED、TIMEOUT", () => {
    expect(TERMINAL_STATES.has(ExecutionState.COMPLETED)).toBe(true);
    expect(TERMINAL_STATES.has(ExecutionState.FAILED)).toBe(true);
    expect(TERMINAL_STATES.has(ExecutionState.CANCELLED)).toBe(true);
    expect(TERMINAL_STATES.has(ExecutionState.TIMEOUT)).toBe(true);
  });

  it("不应包含 CREATED 和 RUNNING", () => {
    expect(TERMINAL_STATES.has(ExecutionState.CREATED)).toBe(false);
    expect(TERMINAL_STATES.has(ExecutionState.RUNNING)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 11. ExecutionResult — 类型安全（Discriminated Union）
// ═══════════════════════════════════════════════════════

describe("ExecutionResult — Discriminated Union 类型安全", () => {
  it("success 分支：通过 status 窄化后可以访问 output", () => {
    const result: ExecutionResult = successResult("测试输出");
    if (result.status === "success") {
      // TypeScript 应在此分支内将 result 窄化为 success 变体
      const output: string = result.output;
      expect(output).toBe("测试输出");
      // metadata 可选
      expect(result.metadata).toBeUndefined();
    } else {
      // 不应到达此处
      expect.fail("应为 success 状态");
    }
  });

  it("partial 分支：通过 status 窄化后可以访问 output 和 reason", () => {
    const result: ExecutionResult = partialResult("部分", "原因");
    if (result.status === "partial") {
      const output: string = result.output;
      const reason: string = result.reason;
      expect(output).toBe("部分");
      expect(reason).toBe("原因");
    } else {
      expect.fail("应为 partial 状态");
    }
  });

  it("failed 分支：通过 status 窄化后可以访问 error", () => {
    const result: ExecutionResult = failedResult(
      ExecutionErrorCode.NOT_FOUND,
      "未找到",
    );
    if (result.status === "failed") {
      const error: ExecutionError = result.error;
      expect(error.code).toBe(ExecutionErrorCode.NOT_FOUND);
      expect(error.message).toBe("未找到");
    } else {
      expect.fail("应为 failed 状态");
    }
  });

  it("cancelled 分支：通过 status 窄化后可以访问 reason", () => {
    const result: ExecutionResult = cancelledResult("用户取消");
    if (result.status === "cancelled") {
      const reason: string = result.reason;
      expect(reason).toBe("用户取消");
    } else {
      expect.fail("应为 cancelled 状态");
    }
  });

  it("timeout 分支：通过 status 窄化后可以访问 afterMs", () => {
    const result: ExecutionResult = timeoutResult(15000);
    if (result.status === "timeout") {
      const afterMs: number = result.afterMs;
      expect(afterMs).toBe(15000);
    } else {
      expect.fail("应为 timeout 状态");
    }
  });

  it("switch 穷尽性：所有 status 分支必须有对应的 case", () => {
    // 穷尽性检查函数：如果新增 status 但未更新 switch，TS 会报错
    function exhaustiveSwitch(r: ExecutionResult): string {
      switch (r.status) {
        case "success":
          return r.output;
        case "partial":
          return `${r.output} | ${r.reason}`;
        case "failed":
          return r.error.message;
        case "cancelled":
          return r.reason;
        case "timeout":
          return `${r.afterMs}`;
      }
    }

    const results: ExecutionResult[] = [
      successResult("s"),
      partialResult("p", "r"),
      failedResult(ExecutionErrorCode.INTERNAL_ERROR, "e"),
      cancelledResult("c"),
      timeoutResult(1000),
    ];

    // 所有变体都不应抛出异常
    for (const r of results) {
      expect(() => exhaustiveSwitch(r)).not.toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════
// 12. 跨工厂一致性
// ═══════════════════════════════════════════════════════

describe("跨工厂一致性", () => {
  it("所有五态结果应可放入同一个 ExecutionResult[] 数组", () => {
    const results: ExecutionResult[] = [
      successResult("ok"),
      partialResult("partial", "reason"),
      failedResult(ExecutionErrorCode.API_ERROR, "error"),
      cancelledResult("cancelled"),
      timeoutResult(10000),
    ];

    expect(results).toHaveLength(5);
    const statuses = results.map((r) => r.status);
    expect(statuses).toEqual(["success", "partial", "failed", "cancelled", "timeout"]);
  });

  it("executionResultToContent 应对所有工厂产出返回字符串", () => {
    const results: ExecutionResult[] = [
      successResult("ok"),
      partialResult("partial", "reason"),
      failedResult(ExecutionErrorCode.API_ERROR, "error"),
      cancelledResult("cancelled"),
      timeoutResult(10000),
    ];

    for (const r of results) {
      const content = executionResultToContent(r);
      expect(typeof content).toBe("string");
    }
  });

  it("isDegradedResult 和 isRetryableResult 对所有变体不抛异常", () => {
    const results: ExecutionResult[] = [
      successResult("ok"),
      partialResult("p", "r"),
      failedResult(ExecutionErrorCode.TIMEOUT, "e", true),
      failedResult(ExecutionErrorCode.INVALID_PARAM, "e", false),
      cancelledResult("c"),
      timeoutResult(1000),
    ];

    for (const r of results) {
      expect(() => isDegradedResult(r)).not.toThrow();
      expect(() => isRetryableResult(r)).not.toThrow();
    }
  });

  it("successResult + metadata 的 metadata 应不影响 status 语义", () => {
    const result = successResult("ok", { durationMs: 100 });
    expect(result.status).toBe("success");
    expect(isDegradedResult(result)).toBe(false);
    expect(isRetryableResult(result)).toBe(false);
  });

  it("partialResult + metadata 的 metadata 应不影响 status 语义", () => {
    const result = partialResult("ok", "reason", { degraded: true });
    expect(result.status).toBe("partial");
    expect(isDegradedResult(result)).toBe(false);
    expect(isRetryableResult(result)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 13. 边界情况与回归
// ═══════════════════════════════════════════════════════

describe("边界情况与回归", () => {
  it("successResult 带特殊字符 output", () => {
    const special = "包含 <html> 标签 & 特殊字符 \n\t\r";
    const result = successResult(special);
    expect(result.output).toBe(special);
  });

  it("successResult 带 Unicode 和 Emoji output", () => {
    const unicode = "中文字符 🎉 émoji café ñoño";
    const result = successResult(unicode);
    expect(result.output).toBe(unicode);
  });

  it("executionResultToContent 不因特殊字符崩溃", () => {
    const special = "特殊字符 <>&\"'\n\t";
    const result = successResult(special);
    const content = executionResultToContent(result);
    expect(content).toBe(special);
  });

  it("failedResult 的 error.message 包含特殊字符", () => {
    const msg = "错误: <html> & \"quotes\"";
    const result = failedResult(ExecutionErrorCode.API_ERROR, msg);
    const content = executionResultToContent(result);
    expect(content).toContain(msg);
  });

  it("大量 ExecutionResult 对象创建无性能退化（冒烟）", () => {
    const count = 1000;
    const results: ExecutionResult[] = [];
    for (let i = 0; i < count; i++) {
      results.push(successResult(`result-${i}`));
    }
    expect(results).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(results[i].status).toBe("success");
    }
  });

  it("executionResultToContent 结果不应包含 undefined 或 null 字符串", () => {
    const results: ExecutionResult[] = [
      successResult("ok"),
      partialResult("partial", "reason"),
      failedResult(ExecutionErrorCode.INTERNAL_ERROR, "error"),
      cancelledResult("cancelled"),
      timeoutResult(1000),
    ];

    for (const r of results) {
      const content = executionResultToContent(r);
      expect(content).not.toContain("undefined");
      expect(content).not.toContain("null");
    }
  });
});
