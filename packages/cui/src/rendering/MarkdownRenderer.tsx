// ── Markdown 渲染器 ──
// 基于 react-markdown 的轻量包装，提供代码高亮和 GFM 支持
//
// 传入 citeIndexes 时，正文里的 [n] 会渲染为可点击锚点，点击滚动到对应引用卡片。
// 注入走「元素渲染器 + 子节点递归」，而不是对 markdown 字符串做 split ——
// 后者会误伤代码块、内联代码与链接 label 里的 [1]。

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { scrollToCite } from "../cards/CitationCardList";

interface Props {
  content: string;
  /** 可锚定的引用编号集合；不传则退化为纯 Markdown 渲染 */
  citeIndexes?: number[];
  /** 锚点作用域，通常传消息 id，避免多条消息互相干扰 */
  citeScope?: string;
  /** 覆写 [n] 点击行为；默认滚动并高亮对应卡片 */
  onCite?: (index: number) => void;
}

export function MarkdownRenderer({
  content,
  citeIndexes,
  citeScope,
  onCite,
}: Props) {
  if (!content) return null;

  const enabled = Boolean(citeIndexes && citeIndexes.length);
  const indexes = new Set(citeIndexes ?? []);
  const handleCite =
    onCite ?? ((index: number) => scrollToCite(citeScope ?? "default", index));

  const wrap = (children: ReactNode) =>
    enabled ? injectCites(children, indexes, handleCite) : children;

  // 仅在启用锚点时覆写渲染器；标签保持默认层级，不改变既有观感
  const components = enabled
    ? {
        p: ({ children }: { children?: ReactNode }) => <p>{wrap(children)}</p>,
        li: ({ children }: { children?: ReactNode }) => <li>{wrap(children)}</li>,
        strong: ({ children }: { children?: ReactNode }) => (
          <strong>{wrap(children)}</strong>
        ),
        em: ({ children }: { children?: ReactNode }) => <em>{wrap(children)}</em>,
        td: ({ children }: { children?: ReactNode }) => <td>{wrap(children)}</td>,
        th: ({ children }: { children?: ReactNode }) => <th>{wrap(children)}</th>,
        h1: ({ children }: { children?: ReactNode }) => <h1>{wrap(children)}</h1>,
        h2: ({ children }: { children?: ReactNode }) => <h2>{wrap(children)}</h2>,
        h3: ({ children }: { children?: ReactNode }) => <h3>{wrap(children)}</h3>,
        h4: ({ children }: { children?: ReactNode }) => <h4>{wrap(children)}</h4>,
      }
    : undefined;

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** 递归把字符串子节点里的 [n] 换成可点击锚点；代码块与内联代码原样保留 */
function injectCites(
  children: ReactNode,
  indexes: Set<number>,
  onCite: (index: number) => void,
): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child === "string" || typeof child === "number") {
      return (
        <CiteChips key={i} text={String(child)} indexes={indexes} onCite={onCite} />
      );
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      // tag 只对原生元素是字符串；自定义组件不做注入，避免越界改动
      const tag = typeof child.type === "string" ? child.type : "";
      if (tag === "code" || tag === "pre") return child;
      if (child.props.children != null) {
        return cloneElement(child, {
          children: injectCites(child.props.children, indexes, onCite),
        });
      }
    }
    return child;
  });
}

function CiteChips({
  text,
  indexes,
  onCite,
}: {
  text: string;
  indexes: Set<number>;
  onCite: (index: number) => void;
}) {
  const parts = text.split(/(\[\d+\])/);
  if (parts.length === 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (!match) return <span key={i}>{part}</span>;
        const index = Number(match[1]);
        // 未在引用集合里的编号（例如模型自己编的）保持纯文本
        if (!indexes.has(index)) return <span key={i}>{part}</span>;
        return (
          <button
            key={i}
            type="button"
            className="inline cursor-pointer p-0 align-baseline font-semibold text-blue-600 hover:underline"
            title="定位到引用的文档卡片"
            onClick={() => onCite(index)}
          >
            {part}
          </button>
        );
      })}
    </>
  );
}

export default MarkdownRenderer;
