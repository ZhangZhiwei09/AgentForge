import { describe, it, expect } from "vitest";
import { extractCardBlocks, hasUnclosedFence } from "../card-parser";
import type { ContentBlock } from "@agentforge/shared-types";

/** Helper: assert block has data field (exclude TextBlock) */
function getBlockData(block: ContentBlock): Record<string, unknown> {
  if ("data" in block) return block.data as unknown as Record<string, unknown>;
  throw new Error(`Block type ${block.type} has no data field`);
}

describe("extractCardBlocks", () => {
  it("returns clean markdown and no blocks for plain text", () => {
    const result = extractCardBlocks("你好，有什么可以帮助您的？");
    expect(result.cleanMarkdown).toBe("你好，有什么可以帮助您的？");
    expect(result.blocks).toHaveLength(0);
  });

  it("extracts a single order card fence", () => {
    const input = `您的订单信息如下：

\`\`\`card:order
{"orderId": "ORD-001", "status": "shipped", "statusLabel": "已发货", "items": [{"name": "商品A", "quantity": 2, "price": 99.00}], "total": 198.00, "createdAt": "2026-06-01"}
\`\`\`

如有问题请随时联系。`;

    const result = extractCardBlocks(input);

    expect(result.cleanMarkdown).toContain("您的订单信息如下：");
    expect(result.cleanMarkdown).toContain("如有问题请随时联系。");
    expect(result.cleanMarkdown).not.toContain("```card:order");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.block.type).toBe("order_card");

    const data = getBlockData(result.blocks[0]!.block);
    expect(data.orderId).toBe("ORD-001");
    expect(data.status).toBe("shipped");
  });

  it("extracts multiple card fences of different types", () => {
    const input = `回答内容。

\`\`\`card:policy
{"category": "退换货政策", "title": "7天无理由退货", "conditions": ["商品完好", "不影响二次销售"]}
\`\`\`

更多文本。

\`\`\`card:action
{"title": "您可能需要", "description": "", "actions": [{"label": "查询订单", "action": "lookup_order"}]}
\`\`\`

结束。`;

    const result = extractCardBlocks(input);

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.block.type).toBe("policy_card");
    expect(result.blocks[1]!.block.type).toBe("action_card");
    expect(result.cleanMarkdown).not.toContain("```card:");
  });

  it("handles malformed JSON gracefully (card fence is removed from markdown)", () => {
    const input = `前面文本。

\`\`\`card:order
{invalid json!!!
\`\`\`

后面文本。`;

    const result = extractCardBlocks(input);

    // Malformed JSON → no block, but fence is removed from markdown
    expect(result.blocks).toHaveLength(0);
    expect(result.cleanMarkdown).not.toContain("```card:");
    expect(result.cleanMarkdown).toContain("前面文本");
    expect(result.cleanMarkdown).toContain("后面文本");
  });

  it("handles status card with steps", () => {
    const input = `\`\`\`card:status
{"title": "物流追踪", "status": "in_progress", "message": "运输中", "steps": [{"label": "已揽收", "status": "done", "description": "2026-06-10 上海"}, {"label": "运输中", "status": "active", "description": "2026-06-12 武汉"}]}
\`\`\``;

    const result = extractCardBlocks(input);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.block.type).toBe("status_card");

    const data = getBlockData(result.blocks[0]!.block);
    expect(data.title).toBe("物流追踪");
    const steps = data.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe("done");
  });

  it("extracts table card", () => {
    const input = `\`\`\`card:table
{"headers": ["类目", "退货期限", "条件"], "rows": [["电子产品", "7天", "未激活"], ["服装", "15天", "吊牌完好"]]}
\`\`\``;

    const result = extractCardBlocks(input);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.block.type).toBe("table");
  });

  it("does not affect regular code blocks (non-card fences)", () => {
    const input = `这是一段代码：

\`\`\`python
print("hello")
\`\`\`

继续文本。`;

    const result = extractCardBlocks(input);

    expect(result.blocks).toHaveLength(0);
    expect(result.cleanMarkdown).toContain("```python");
    expect(result.cleanMarkdown).toContain('print("hello")');
  });
});

describe("hasUnclosedFence", () => {
  it("returns null for text without card fences", () => {
    expect(hasUnclosedFence("普通文本")).toBeNull();
  });

  it("returns null for closed card fences", () => {
    const input = `\`\`\`card:order
{"orderId": "123"}
\`\`\``;
    expect(hasUnclosedFence(input)).toBeNull();
  });

  it("detects unclosed order fence", () => {
    const input = '前面文本\n```card:order\n{"orderId":';
    expect(hasUnclosedFence(input)).toBe("order");
  });

  it("returns null when unclosed fence is a regular code block", () => {
    const input = "```python\nprint(";
    expect(hasUnclosedFence(input)).toBeNull();
  });
});
