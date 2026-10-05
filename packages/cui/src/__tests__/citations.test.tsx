// 引用锚点与引用卡片过滤的单元测试
//
// 重点覆盖 Spec §3.4/§5 的约束：注入必须发生在元素渲染器层，
// 代码块与内联代码里的 [1] 不能被误判成引用。

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownRenderer } from "../rendering/MarkdownRenderer";
import { filterCitedCards } from "../cards/CitationCardList";
import type { CitationCard } from "@agentforge/shared-types";

const CARDS: CitationCard[] = [
  {
    index: 1,
    docId: "doc-1",
    docTitle: "退换货政策",
    excerpt: "收到商品后 7 天内可申请",
    score: 0.9,
  },
  {
    index: 2,
    docId: "doc-2",
    docTitle: "发票说明",
    excerpt: "支持开具电子发票",
    score: 0.7,
  },
];

describe("MarkdownRenderer 引用锚点", () => {
  it("把正文 [n] 渲染为可点击锚点并回调 index", () => {
    const onCite = vi.fn();
    render(
      <MarkdownRenderer
        content="退换货需要在7天内申请[1]。"
        citeIndexes={[1, 2]}
        onCite={onCite}
      />,
    );

    const chip = screen.getByRole("button", { name: "[1]" });
    fireEvent.click(chip);
    expect(onCite).toHaveBeenCalledWith(1);
  });

  it("不在引用集合里的编号保持纯文本，不生成按钮", () => {
    render(
      <MarkdownRenderer
        content="参见[9]的说明。"
        citeIndexes={[1, 2]}
        onCite={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("不注入内联代码与围栏代码块里的 [1]", () => {
    render(
      <MarkdownRenderer
        content={
          "数组下标 `a[1]` 不是引用。\n\n```js\nconst x = a[1];\n```\n"
        }
        citeIndexes={[1, 2]}
        onCite={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("未传 citeIndexes 时退化为纯 Markdown 渲染", () => {
    render(<MarkdownRenderer content="退换货需要在7天内申请[1]。" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("列表项里的 [n] 同样可锚定", () => {
    const onCite = vi.fn();
    render(
      <MarkdownRenderer
        content={"- 第一条依据[2]\n- 第二条无引用\n"}
        citeIndexes={[1, 2]}
        onCite={onCite}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "[2]" }));
    expect(onCite).toHaveBeenCalledWith(2);
  });
});

describe("filterCitedCards", () => {
  it("只保留正文实际标注的编号", () => {
    const kept = filterCitedCards(CARDS, "依据[2]的说明。");
    expect(kept.map((c) => c.index)).toEqual([2]);
  });

  it("正文未标注任何 [n] 时回退为全部召回", () => {
    expect(filterCitedCards(CARDS, "没有任何编号的回答。")).toHaveLength(2);
  });

  it("空卡片列表返回空", () => {
    expect(filterCitedCards([], "依据[1]。")).toEqual([]);
  });
});
