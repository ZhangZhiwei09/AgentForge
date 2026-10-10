import type { EntryRouteDefinition, EntryRouteNode } from "@agentforge/shared-types";

export function emptyEntryTemplate(): EntryRouteDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "start", name: "开始", type: "start", position: { x: 0, y: 100 } },
      { id: "fallback", name: "继续智能路由", type: "continue", position: { x: 280, y: 100 } },
    ],
    edges: [{ id: "start_fallback", source: "start", target: "fallback", branch: null }],
  };
}

// This is an editable keyword baseline, not an equivalent conversion of legacy regexes.
export function defaultEntryTemplate(): EntryRouteDefinition {
  const nodes: EntryRouteNode[] = [{ id: "start", name: "开始", type: "start", position: { x: 0, y: 280 } }];
  const edges: EntryRouteDefinition["edges"] = [];
  const rules = [
    { id: "greeting", name: "问候", words: ["你好", "hi", "hello", "嗨", "您好", "早上好", "下午好", "晚上好", "在吗", "在不在"], answer: "你好，我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。需要什么帮助？", suggestions: ["查询知识库", "诊断系统故障"] },
    { id: "thanks", name: "感谢", words: ["谢谢", "感谢", "多谢", "谢谢你", "谢谢您", "thanks", "thank you", "3q"], answer: "不客气。还有其他问题可以随时找我。", suggestions: [] },
    { id: "farewell", name: "告别", words: ["再见", "拜拜", "bye", "88", "下次见", "回头见"], answer: "再见。", suggestions: [] },
    { id: "human", name: "转人工", words: ["转人工", "找人工", "找真人", "找客服", "我要投诉"] },
    { id: "diagnosis", name: "故障诊断", words: ["traceId:", "traceId：", "error_code:", "报错", "失败", "超时", "打不开", "连不上", "崩溃", "闪退", "白屏", "卡死"] },
  ];
  for (const [index, rule] of rules.entries()) {
    const x = 270 + index * 270;
    nodes.push({
      id: rule.id, name: rule.name, type: "condition", position: { x, y: 280 },
      condition: {
        operator: "answer" in rule ? "equals_any" : "contains_any", words: rule.words, excludeAny: [],
        ignoreCase: true, stripTrailingPunctuation: "answer" in rule,
      },
    });
    nodes.push("answer" in rule
      ? { id: `${rule.id}_result`, name: `${rule.name}回复`, type: "reply", position: { x, y: 40 }, answer: rule.answer!, suggestions: rule.suggestions! }
      : { id: `${rule.id}_result`, name: rule.name, type: "route", position: { x, y: 40 }, target: rule.id === "human" ? "HUMAN" : "DIAGNOSIS" });
    edges.push(
      { id: `${rule.id}_hit`, source: rule.id, target: `${rule.id}_result`, branch: "true" },
      { id: `${rule.id}_miss`, source: rule.id, target: rules[index + 1]?.id ?? "fallback", branch: "false" },
    );
  }
  nodes.push({ id: "fallback", name: "继续智能路由", type: "continue", position: { x: 1620, y: 280 } });
  edges.unshift({ id: "start_first", source: "start", target: rules[0].id, branch: null });
  return { schemaVersion: 1, nodes, edges };
}
