// ── 富消息渲染器 ──
// 将 Markdown 文本中的卡片围栏提取为 React 组件，剩余文本经 MarkdownRenderer 渲染
//
// 流式增强：检测到未闭合的 ```card:type 时，立即渲染骨架卡片，
// 随着 LLM 输出更多 JSON 字段，卡片渐进式填充。

import { useMemo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import {
  extractCardBlocks,
  hasUnclosedFence,
  tryParseStreamingCard,
} from "./card-parser";
import { OrderCard } from "./cards/OrderCard";
import { PolicyCard } from "./cards/PolicyCard";
import { ActionCard } from "./cards/ActionCard";
import { StatusCard } from "./cards/StatusCard";
import type { ContentBlock } from "@agentforge/shared-types";

interface Props {
  content: string;
  /** 是否正在流式接收中 */
  isStreaming?: boolean;
}

export function RichMessageRenderer({ content, isStreaming }: Props) {
  // 流式过程中：尝试渐进解析未闭合的卡片围栏
  const streamingCard = useMemo(() => {
    if (!isStreaming) return null;
    return tryParseStreamingCard(content);
  }, [content, isStreaming]);

  const { cleanMarkdown, blocks } = useMemo(() => {
    // 流式过程中如果有正在构建的卡片，跳过完整解析（避免半截 JSON 错误）
    if (streamingCard && !streamingCard.isComplete) {
      // 切除原始卡片围栏文本，只渲染前置文本 + 骨架卡片
      const beforeFence = content.slice(0, streamingCard.fenceStartIndex);
      const afterFence = content.slice(
        streamingCard.fenceStartIndex + streamingCard.fenceLength,
      );
      return { cleanMarkdown: (beforeFence + afterFence).trim(), blocks: [] };
    }

    // 流式结束或围栏已闭合：正常解析
    if (isStreaming && hasUnclosedFence(content)) {
      return { cleanMarkdown: content, blocks: [] };
    }
    return extractCardBlocks(content);
  }, [content, isStreaming, streamingCard]);

  // 流式 + 正在构建卡片：渲染文本 + 骨架卡片
  if (streamingCard && !streamingCard.isComplete) {
    return (
      <div className="space-y-3">
        {cleanMarkdown && <MarkdownRenderer content={cleanMarkdown} />}
        {renderStreamingCard(streamingCard)}
      </div>
    );
  }

  // 流式 + 完整卡片已解析
  if (blocks.length > 0) {
    return (
      <div className="space-y-3">
        {renderInterleaved(cleanMarkdown, blocks)}
      </div>
    );
  }

  // 无卡片块时直接用 MarkdownRenderer
  return <MarkdownRenderer content={content} />;
}

/**
 * 渲染正在流式构建中的卡片（骨架 + 部分数据）
 */
function renderStreamingCard(
  streaming: ReturnType<typeof tryParseStreamingCard>,
): React.ReactNode {
  if (!streaming) return null;

  const { type, partialData } = streaming;
  const key = `streaming-card`;

  // 将部分数据包装为 ContentBlock 传给卡片组件
  // 卡片组件通过 isStreaming prop 显示骨架
  switch (type) {
    case "order":
      return (
        <OrderCard key={key} data={partialData as any} isStreaming={true} />
      );
    case "policy":
      return (
        <PolicyCard key={key} data={partialData as any} isStreaming={true} />
      );
    case "action":
      return (
        <ActionCard key={key} data={partialData as any} isStreaming={true} />
      );
    case "status":
      return (
        <StatusCard key={key} data={partialData as any} isStreaming={true} />
      );
    case "table":
      // 表格回退到 Markdown 渲染（部分行）
      if (partialData.headers && partialData.rows) {
        return (
          <MarkdownRenderer
            key={key}
            content={buildTableMarkdown(
              partialData.headers as string[],
              partialData.rows as string[][],
            )}
          />
        );
      }
      return null;
    default:
      return null;
  }
}

/**
 * 将纯净 Markdown 文本按卡片位置切分，并在对应位置插入卡片组件
 */
function renderInterleaved(
  cleanMarkdown: string,
  blocks: Array<{ index: number; block: ContentBlock }>,
) {
  const elements: React.ReactNode[] = [];

  if (cleanMarkdown) {
    elements.push(<MarkdownRenderer key="text-main" content={cleanMarkdown} />);
  }

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
