import { describe, expect, it } from "vitest";
import type { EntryRouteDefinition } from "@agentforge/shared-types";
import { executeEntryFlow } from "../runtime.js";
import { entryDefinitionSchema, parseEntryDefinition, validateEntryDefinition } from "../schema.js";
import { defaultEntryTemplate, emptyEntryTemplate } from "../templates.js";
import { redactEntryText, redactEntryValue } from "../privacy.js";

function branchFlow(operator: "contains_any" | "contains_all" | "equals_any" = "contains_any"): EntryRouteDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "start", type: "start", name: "start", position: { x: 0, y: 0 } },
      { id: "condition", type: "condition", name: "condition", position: { x: 200, y: 0 },
        condition: { operator, words: ["hello", "world"], excludeAny: ["deny"], ignoreCase: true, stripTrailingPunctuation: operator === "equals_any" } },
      { id: "reply", type: "reply", name: "reply", position: { x: 400, y: 0 }, answer: "configured answer", suggestions: ["next"] },
      { id: "continue", type: "continue", name: "continue", position: { x: 400, y: 200 } },
    ],
    edges: [
      { id: "first", source: "start", target: "condition", branch: null },
      { id: "yes", source: "condition", target: "reply", branch: "true" },
      { id: "no", source: "condition", target: "continue", branch: "false" },
    ],
  };
}

describe("entry flow deterministic semantics", () => {
  it.each([
    ["contains_any", "  HELLO ", "reply"], ["contains_any", "world only", "reply"],
    ["contains_any", "HELLO deny", "continue"], ["contains_any", "unmatched", "continue"],
    ["contains_all", "hello world", "reply"], ["contains_all", "hello", "continue"],
    ["equals_any", " Hello！。 ", "reply"], ["equals_any", "hello there", "continue"],
    ["equals_any", "hello?", "continue"], ["equals_any", "he!llo", "continue"],
  ] as const)("%s with %s produces %s", (operator, message, action) => {
    const execution = executeEntryFlow(branchFlow(operator), message);
    expect(execution.result.action).toBe(action);
    expect(execution.records.map((r) => r.nodeId)).toEqual(["start", "condition", action === "reply" ? "reply" : "continue"]);
    expect(execution.records[1].matched).toBe(action === "reply");
  });
  it("honors case-sensitive matching and config normalization", () => {
    const flow = branchFlow("equals_any");
    const condition = flow.nodes[1];
    if (condition.type !== "condition") throw new Error();
    condition.condition.ignoreCase = false;
    condition.condition.words = [" hello！ "];
    expect(executeEntryFlow(flow, " hello。 ").result.action).toBe("reply");
    expect(executeEntryFlow(flow, "Hello").result.action).toBe("continue");
    condition.condition.stripTrailingPunctuation = false;
    expect(executeEntryFlow(flow, "hello。").result.action).toBe("continue");
  });
  it.each(["CHAT", "TASK", "HUMAN", "DIAGNOSIS"] as const)("returns %s without dispatching an Agent", (target) => {
    const flow = branchFlow();
    flow.nodes[2] = { id: "reply", type: "route", name: "route", position: { x: 400, y: 0 }, target };
    expect(executeEntryFlow(flow, "hello").result).toEqual({ action: "route", target });
  });
  it("follows edges independent of array and canvas order", () => {
    const flow = defaultEntryTemplate();
    const before = executeEntryFlow(flow, "转人工失败");
    flow.nodes.reverse();
    flow.nodes.forEach((node, index) => { node.position = { x: -index * 100, y: index * 10 }; });
    flow.edges.reverse();
    const after = executeEntryFlow(flow, "转人工失败");
    expect(after.result).toEqual(before.result);
    expect(after.records.map((r) => r.nodeId)).toEqual(before.records.map((r) => r.nodeId));
    expect(after.result).toEqual({ action: "route", target: "HUMAN" });
  });
  it.each([
    ["你好", "reply"], ["谢谢", "reply"], ["再见", "reply"], ["HI！", "reply"],
    ["转人工", "route"], ["traceId: abc 报错", "route"], ["普通业务咨询", "continue"],
  ] as const)("provides an explicit baseline for %s", (message, action) => {
    expect(executeEntryFlow(defaultEntryTemplate(), message).result.action).toBe(action);
  });
  it("returns configured content unchanged and never mutates config/input", () => {
    const flow = branchFlow();
    const before = JSON.stringify(flow);
    expect(executeEntryFlow(flow, "hello").result).toEqual({ action: "reply", answer: "configured answer", suggestions: ["next"] });
    expect(JSON.stringify(flow)).toBe(before);
  });
  it("checks cancellation before evaluation", () => {
    const abort = new AbortController(); abort.abort();
    expect(() => executeEntryFlow(branchFlow(), "hello", abort.signal)).toThrow();
  });
  it.each(["", " ", "x".repeat(16001)])("bounds messages", (message) => {
    expect(() => executeEntryFlow(branchFlow(), message)).toThrow("消息");
  });
});

describe("entry flow graph validation", () => {
  it.each([emptyEntryTemplate(), defaultEntryTemplate(), branchFlow()])("accepts complete finite graphs", (flow) => {
    expect(validateEntryDefinition(flow)).toEqual({ valid: true, errors: [] });
  });
  const cases: Array<[string, (flow: EntryRouteDefinition) => void]> = [
    ["duplicate node", (flow) => flow.nodes.push({ ...flow.nodes[2] })],
    ["duplicate edge", (flow) => flow.edges[2].id = flow.edges[1].id],
    ["missing reference", (flow) => flow.edges[0].target = "unknown"],
    ["self loop", (flow) => flow.edges[0].target = "start"],
    ["two starts", (flow) => flow.nodes.push({ id: "other", type: "start", name: "other", position: { x: 0, y: 0 } })],
    ["no start", (flow) => flow.nodes = flow.nodes.filter((node) => node.type !== "start")],
    ["no continue", (flow) => flow.nodes[3] = { id: "continue", type: "reply", name: "reply", position: { x: 0, y: 0 }, answer: "answer", suggestions: [] }],
    ["missing false", (flow) => flow.edges.pop()],
    ["duplicate branch", (flow) => flow.edges[2].branch = "true"],
    ["terminal outgoing", (flow) => flow.edges.push({ id: "bad", source: "reply", target: "condition", branch: null })],
    ["cycle", (flow) => flow.edges[2].target = "condition"],
    ["unreachable", (flow) => flow.nodes.push({ id: "orphan", type: "continue", name: "orphan", position: { x: 0, y: 0 } })],
    ["extra start edge", (flow) => flow.edges.push({ id: "extra", source: "start", target: "reply", branch: null })],
    ["invalid handoff", (flow) => flow.nodes[2] = { id: "reply", type: "route", target: "CHAT", name: "reply", position: { x: 0, y: 0 }, handoff: { withinHours: "yes", outsideHours: "no", suggestions: [] } }],
    ["empty word", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.words = [" "]; }],
    ["normalized empty word", (flow) => { if (flow.nodes[1].type === "condition") { flow.nodes[1].condition.operator = "equals_any"; flow.nodes[1].condition.stripTrailingPunctuation = true; flow.nodes[1].condition.words = ["！"]; } }],
    ["contradictory word", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.excludeAny = ["HELLO"]; }],
    ["duplicate normalized word", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.words = ["hello", "HELLO"]; }],
    ["unsupported punctuation mode", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.stripTrailingPunctuation = true; }],
    ["too many words", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.words = Array.from({ length: 51 }, (_, i) => `word${i}`); }],
    ["word too long", (flow) => { if (flow.nodes[1].type === "condition") flow.nodes[1].condition.words = ["x".repeat(129)]; }],
    ["reply too long", (flow) => { if (flow.nodes[2].type === "reply") flow.nodes[2].answer = "x".repeat(8001); }],
    ["too many suggestions", (flow) => { if (flow.nodes[2].type === "reply") flow.nodes[2].suggestions = Array(6).fill("suggestion"); }],
    ["too many nodes", (flow) => { for (let i = 0; i < 31; i++) flow.nodes.push({ id: `extra${i}`, name: "extra", type: "continue", position: { x: i, y: i } }); }],
    ["too many edges", (flow) => { for (let i = 0; i < 61; i++) flow.edges.push({ id: `extra${i}`, source: "start", target: "reply", branch: null }); }],
  ];
  it.each(cases)("rejects %s", (_, mutate) => {
    const flow = branchFlow(); mutate(flow);
    expect(validateEntryDefinition(flow).valid).toBe(false);
    expect(() => parseEntryDefinition(flow)).toThrow();
  });
  it("permits structurally sound drafts with incomplete connections, but rejects execution", () => {
    const flow = branchFlow(); flow.edges.pop();
    expect(entryDefinitionSchema.safeParse(flow).success).toBe(true);
    expect(() => executeEntryFlow(flow, "unmatched")).toThrow();
  });
  it("permits a start-only disconnected draft without allowing publication", () => {
    const flow = emptyEntryTemplate(); flow.nodes.pop(); flow.edges = [];
    expect(entryDefinitionSchema.safeParse(flow).success).toBe(true);
    expect(validateEntryDefinition(flow).valid).toBe(false);
  });
  it.each([{ ...branchFlow(), script: "arbitrary" }, { ...branchFlow(), schemaVersion: 2 }])("rejects unknown fields and schema versions", (value) => {
    expect(validateEntryDefinition(value).valid).toBe(false);
  });
});

describe("entry run privacy", () => {
  it("removes common credentials and personal data from summaries and nested snapshots", () => {
    const input = "Bearer abc.def.ghi api_key=secret password:12345 sk-12345678901234567890 a@example.test 13812345678";
    expect(redactEntryText(input)).not.toContain("12345");
    expect(redactEntryText(input)).not.toContain("a@example.test");
    expect(redactEntryValue({ answer: input, password: "supersecret", nodes: [{ name: "safe" }] })).toEqual({
      answer: "Bearer [REDACTED] api_key=[REDACTED] password:[REDACTED] [REDACTED] [EMAIL] [PHONE]",
      password: "[REDACTED]", nodes: [{ name: "safe" }],
    });
  });
});
