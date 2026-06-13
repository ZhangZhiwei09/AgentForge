// ── 富消息渲染器 ──
// 将 Markdown 文本中的卡片围栏提取为 React 组件，剩余文本经 MarkdownRenderer 渲染
// 流式过程中：仅渲染文本（卡片需等待 closing fence 到达后才渲染）

import { useMemo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { extractCardBlocks, hasUnclosedFence } from "./card-parser";
import { OrderCard } from "./cards/OrderCard";
import { PolicyCard } from "./cards/PolicyCard";
import { ActionCard } from "./cards/ActionCard";
import { StatusCard } from "./cards/StatusCard";
import type { ContentBlock } from "@agentforge/shared-types";

interface Props {
  content: string;
  /** 是否正在流式接收中。流式过程中不渲染卡片（避免半截 JSON 错误） */
  isStreaming?: boolean;
}

export function RichMessageRenderer({ content, isStreaming }: Props) {
  const { cleanMarkdown, blocks } = useMemo(() => {
    // 流式过程中：只做 Markdown 渲染，不解析卡片
    if (isStreaming && hasUnclosedFence(content)) {
      return { cleanMarkdown: content, blocks: [] };
    }
    return extractCardBlocks(content);
  }, [content, isStreaming]);

  // 无卡片块时直接用 MarkdownRenderer
  if (blocks.length === 0) {
    return <MarkdownRenderer content={content} />;
  }

  // 有卡片块时：交错的文本 + 卡片
  return (
    <div className="space-y-3">
      {/* 在卡片之间的文本段 */}
      {renderInterleaved(cleanMarkdown, blocks)}
    </div>
  );
}

/**
 * 将纯净 Markdown 文本按卡片位置切分，并在对应位置插入卡片组件
 *
 * 简化实现：先渲染纯 Markdown，再逐一追加卡片
 * 对于流式场景，卡片总是在文本末尾出现，这种简化足够用
 */
function renderInterleaved(
  cleanMarkdown: string,
  blocks: Array<{ index: number; block: ContentBlock }>,
) {
  const elements: React.ReactNode[] = [];

  // 渲染文本（如果还有内容）
  if (cleanMarkdown) {
    elements.push(<MarkdownRenderer key="text-main" content={cleanMarkdown} />);
  }

  // 渲染每个卡片
  blocks.forEach(({ block }, i) => {
    elements.push(renderBlock(block, `card-${i}`));
  });

  return elements;
}

/**
 * 根据 ContentBlock 类型分发到对应卡片组件
 */
function renderBlock(block: ContentBlock, key: string): React.ReactNode {
  switch (block.type) {
    case "order_card":
      return <OrderCard key={key} data={block.data} />;
    case "policy_card":
      return <PolicyCard key={key} data={block.data} />;
    case "action_card":
      return <ActionCard key={key} data={block.data} />;
    case "status_card":
      return <StatusCard key={key} data={block.data} />;
    case "table":
      // 表格型卡片用 Markdown 渲染回退
      return (
        <MarkdownRenderer
          key={key}
          content={buildTableMarkdown(block.data.headers, block.data.rows)}
        />
      );
    case "text":
    default:
      return <MarkdownRenderer key={key} content={block.content} />;
  }
}

function buildTableMarkdown(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, sepLine, ...rowLines].join("\n");
}

export default RichMessageRenderer;
