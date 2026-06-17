import { useState, useEffect } from "react";
import {
  Search,
  ChevronRight,
  BookOpen,
  FileText,
  Loader2,
} from "lucide-react";

interface FAQDocument {
  id: string;
  title: string;
  content: string;
  chunkCount: number;
  status: string;
}

interface FAQCategory {
  name: string;
  documents: FAQDocument[];
  count: number;
}

interface FAQSidebarProps {
  onSelectQuestion: (question: string) => void;
}

/** 校验 FAQ 文档数组是否为有效数据 */
function isFAQDocumentArray(raw: unknown): raw is FAQDocument[] {
  if (!Array.isArray(raw)) return false;
  return raw.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).title === "string",
  );
}

/** 校验 FAQ 分类数组是否为有效数据 */
function isFAQCategoryArray(raw: unknown): raw is FAQCategory[] {
  if (!Array.isArray(raw)) return false;
  return raw.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === "string" &&
      typeof (item as Record<string, unknown>).count === "number",
  );
}

/** 校验 FAQ 文档详情是否为有效数据 */
function isFAQDetail(
  raw: unknown,
): raw is { content: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).content === "string"
  );
}

export function FAQSidebar({ onSelectQuestion }: FAQSidebarProps) {
  const [categories, setCategories] = useState<FAQCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  // 加载 FAQ 分类和文档（使用公开的 customer-chat 接口）
  useEffect(() => {
    async function loadFAQs() {
      try {
        const [catRes, docsRes] = await Promise.all([
          fetch("/api/agent/chat/faq/categories"),
          fetch("/api/agent/chat/faq"),
        ]);

        if (!catRes.ok || !docsRes.ok) throw new Error("Failed to fetch FAQs");

        const catData: unknown = await catRes.json();
        const docsData: unknown = await docsRes.json();

        // 边界校验：提取并验证嵌套的数组字段
        const catList: unknown =
          typeof catData === "object" && catData !== null
            ? (catData as Record<string, unknown>).categories
            : undefined;
        const docList: unknown =
          typeof docsData === "object" && docsData !== null
            ? (docsData as Record<string, unknown>).documents
            : undefined;

        if (!isFAQCategoryArray(catList) || !isFAQDocumentArray(docList)) {
          console.error("Invalid FAQ API response shape");
          return;
        }

        const completedDocs = docList.filter((d) => d.status === "completed");

        const cats: FAQCategory[] = catList
          .filter((cat) => cat.count > 0)
          .map((cat) => ({
            ...cat,
            documents: completedDocs,
          }));

        setCategories(cats);
      } catch (err) {
        console.error("Failed to load FAQs:", err);
      } finally {
        setLoading(false);
      }
    }
    loadFAQs();
  }, []);

  // 获取文档详情
  async function loadDocDetail(docId: string) {
    setDocLoading(true);
    setDocContent(null);
    try {
      const res = await fetch(`/api/agent/chat/faq/${docId}`);
      if (res.ok) {
        const raw: unknown = await res.json();
        if (isFAQDetail(raw)) {
          setDocContent(raw.content);
        } else {
          console.error("Invalid FAQ detail response shape");
          setDocContent("加载失败");
        }
      }
    } catch (err) {
      console.error("Failed to load FAQ detail:", err);
      setDocContent("加载失败");
    } finally {
      setDocLoading(false);
    }
  }

  function handleDocClick(docId: string, title: string) {
    if (expandedDoc === docId) {
      setExpandedDoc(null);
      setDocContent(null);
    } else {
      setExpandedDoc(docId);
      loadDocDetail(docId);
    }
  }

  const filteredCategories = searchQuery
    ? categories
        .map((cat) => ({
          ...cat,
          documents: cat.documents.filter(
            (d) =>
              d.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
              (docContent &&
                expandedDoc === d.id &&
                docContent.includes(searchQuery)),
          ),
        }))
        .filter((cat) => cat.documents.length > 0)
    : categories;

  return (
    <aside className="flex h-full flex-col border-r border-[hsl(var(--cs-border))] bg-white w-64">
      {/* 搜索 */}
      <div className="border-b border-[hsl(var(--cs-border))] p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索帮助文档..."
            className="w-full rounded-lg border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] py-2 pl-8 pr-3 text-xs outline-none transition-colors focus:border-[hsl(var(--cs-primary))] focus:ring-1 focus:ring-[hsl(var(--cs-primary))]/20"
          />
        </div>
      </div>

      {/* FAQ 列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        )}

        {!loading && filteredCategories.length === 0 && (
          <div className="px-4 py-12 text-center">
            <BookOpen className="mx-auto mb-2 h-5 w-5 text-[hsl(var(--muted-foreground))]/40" />
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {searchQuery ? "未找到相关文档" : "暂无帮助文档"}
            </p>
          </div>
        )}

        {!loading &&
          filteredCategories.map((cat) => (
            <div key={cat.name}>
              {/* 分类标题 */}
              <button
                onClick={() =>
                  setExpandedCategory(
                    expandedCategory === cat.name ? null : cat.name,
                  )
                }
                className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-[hsl(var(--cs-bg))] transition-colors"
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="h-3.5 w-3.5 text-[hsl(var(--cs-primary))]" />
                  <span className="text-sm font-medium text-[hsl(var(--foreground))]">
                    {cat.name}
                  </span>
                  <span className="rounded-full bg-[hsl(var(--cs-primary-light))] px-1.5 py-0.5 text-[10px] font-medium text-[hsl(var(--cs-primary))]">
                    {cat.count}
                  </span>
                </div>
                <ChevronRight
                  className={`h-3.5 w-3.5 text-[hsl(var(--muted-foreground))] transition-transform ${
                    expandedCategory === cat.name ? "rotate-90" : ""
                  }`}
                />
              </button>

              {/* 文档列表 */}
              {expandedCategory === cat.name && (
                <div className="border-b border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))]/50">
                  {cat.documents.map((doc) => (
                    <div key={doc.id}>
                      <button
                        onClick={() => handleDocClick(doc.id, doc.title)}
                        className="flex w-full items-center gap-2 px-6 py-2 text-left text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--cs-bg))] transition-colors"
                      >
                        <FileText className="h-3 w-3 shrink-0" />
                        <span className="truncate">{doc.title}</span>
                      </button>

                      {/* 文档预览 */}
                      {expandedDoc === doc.id && (
                        <div className="px-6 pb-3 animate-fade-in">
                          {docLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]" />
                          ) : docContent ? (
                            <div className="space-y-2">
                              <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-5">
                                {docContent}
                              </p>
                              <button
                                onClick={() => onSelectQuestion(doc.title)}
                                className="text-[11px] text-[hsl(var(--cs-primary))] hover:underline"
                              >
                                发送此问题 →
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>

      {/* 底部提示 */}
      <div className="border-t border-[hsl(var(--cs-border))] px-4 py-2.5">
        <p className="text-[10px] text-[hsl(var(--muted-foreground))] text-center">
          未找到答案？直接输入问题联系我们
        </p>
      </div>
    </aside>
  );
}
