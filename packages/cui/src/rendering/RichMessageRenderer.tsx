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
} from "../parsing/card-parser";
import { ActionCard, OrderCard, PolicyCard, StatusCard, TableCard } from "../cards";
import type { ContentBlock, ActionCardData, OrderCardData, PolicyCardData, StatusCardData, TableBlockData } from "@agentforge/shared-types";

/** 引用锚点透传参数：由 RichMessageRenderer 原样传给 MarkdownRenderer */
interface CiteProps {
  citeIndexes?: number[];
  citeScope?: string;
}

interface Props {
  content: string;
  /** 是否正在流式接收中 */
  isStreaming?: boolean;
  /** 引用卡片编号集合；提供时正文 [n] 渲染为可点击锚点 */
  citeIndexes?: number[];
  /** 锚点作用域，通常传消息 id */
  citeScope?: string;
}

export function RichMessageRenderer({
  content,
  isStreaming,
  citeIndexes,
  citeScope,
}: Props) {
  const cite = { citeIndexes, citeScope };
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
        {cleanMarkdown && <MarkdownRenderer content={cleanMarkdown} {...cite} />}
        {renderStreamingCard(streamingCard)}
      </div>
    );
  }

  // 流式 + 完整卡片已解析
  if (blocks.length > 0) {
    return (
      <div className="space-y-3">
        {renderInterleaved(cleanMarkdown, blocks, cite)}
      </div>
    );
  }

  // 无卡片块时直接用 MarkdownRenderer
  return <MarkdownRenderer content={content} {...cite} />;
}

/**
 * 渲染正在流式构建中的卡片（骨架 + 部分数据）
 */
function renderStreamingCard(
  streaming: ReturnType<typeof tryParseStreamingCard>,
): React.ReactNode {
  if (!streaming) return null;

  const { type, partialData } = streaming;
  const key = "streaming-card";

  // 将部分数据包装为对应卡片组件的 props
  // 卡片组件通过 isStreaming prop 显示骨架
  switch (type) {
    case "action":
      return (
        <ActionCard
          key={key}
          // partialData 来自流式截断 JSON 的宽松解析，运行时无法保证类型安全，需显式断言
          data={partialData as unknown as ActionCardData}
          isStreaming={true}
        />
      );
    case "order":
      return (
        <OrderCard
          key={key}
          data={partialData as unknown as OrderCardData}
          isStreaming={true}
        />
      );
    case "policy":
      return (
        <PolicyCard
          key={key}
          data={partialData as unknown as PolicyCardData}
          isStreaming={true}
        />
      );
    case "status":
      return (
        <StatusCard
          key={key}
          data={partialData as unknown as StatusCardData}
          isStreaming={true}
        />
      );
    case "table":
      return (
        <TableCard
          key={key}
          data={partialData as unknown as TableBlockData}
          isStreaming={true}
        />
      );
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
  cite: CiteProps,
) {
  const elements: React.ReactNode[] = [];

  if (cleanMarkdown) {
    elements.push(
      <MarkdownRenderer key="text-main" content={cleanMarkdown} {...cite} />,
    );
  }

  blocks.forEach(({ block }, i) => {
    elements.push(renderBlock(block, `card-${i}`, cite));
  });

  return elements;
}

/**
 * 根据 ContentBlock 类型分发到对应卡片组件
 */
function renderBlock(
  block: ContentBlock,
  key: string,
  cite: CiteProps,
): React.ReactNode {
  switch (block.type) {
    case "action_card":
      return <ActionCard key={key} data={block.data} />;
    case "order_card":
      return <OrderCard key={key} data={block.data} />;
    case "policy_card":
      return <PolicyCard key={key} data={block.data} />;
    case "status_card":
      return <StatusCard key={key} data={block.data} />;
    case "table":
      return <TableCard key={key} data={block.data} />;
    case "text":
    default:
      return (
        <MarkdownRenderer
          key={key}
          content={(block as { content: string }).content}
          {...cite}
        />
      );
  }
}

export default RichMessageRenderer;
