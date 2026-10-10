import type { EntryRouteFlowDTO } from "@agentforge/shared-types";

export function entryFlowFixture(): EntryRouteFlowDTO {
  return {
    id: "d72d3aa1-1f99-48ad-888c-7d6a599a477e", name: "入口流程",
    draft: {
      schemaVersion: 1,
      nodes: [
        { id: "start", type: "start", name: "开始", position: { x: 0, y: 150 } },
        { id: "condition", type: "condition", name: "问候", position: { x: 270, y: 150 }, condition: { operator: "equals_any", words: ["你好"], excludeAny: [], ignoreCase: true, stripTrailingPunctuation: true } },
        { id: "reply", type: "reply", name: "问候回复", position: { x: 540, y: 0 }, answer: "欢迎使用", suggestions: [] },
        { id: "fallback", type: "continue", name: "继续智能路由", position: { x: 540, y: 280 } },
      ],
      edges: [
        { id: "first", source: "start", target: "condition", branch: null },
        { id: "yes", source: "condition", target: "reply", branch: "true" },
        { id: "no", source: "condition", target: "fallback", branch: "false" },
      ],
    },
    draftRevision: 1, published: null, publishedVersion: 0, publishedRevision: 0,
    enabled: false, archived: false, updatedBy: "admin",
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  };
}
