import { useState, useEffect } from "react";
import { MessageCircle, Sparkles, ArrowRight } from "lucide-react";

interface FAQTopic {
  question: string;
  category: string;
}

interface WelcomeScreenProps {
  onSend: (question: string) => void;
}

export function WelcomeScreen({ onSend }: WelcomeScreenProps) {
  const [topics, setTopics] = useState<FAQTopic[]>([]);

  useEffect(() => {
    // 尝试从后端加载热门话题
    fetch("/api/agent/chat/faq/categories")
      .then((res) => res.json())
      .then((data) => {
        if (data.categories && data.categories.length > 0) {
          const questions: FAQTopic[] = data.categories
            .filter((c: { name: string }) => c.name !== "其他咨询")
            .map((c: { name: string }) => ({
              question: `请介绍一下${c.name}相关的信息`,
              category: c.name,
            }));
          setTopics(questions.slice(0, 6));
        }
      })
      .catch(() => {
        // 加载失败则使用默认话题
        setTopics(DEFAULT_TOPICS);
      });
  }, []);

  return (
    <div className="flex items-center justify-center min-h-full px-4 py-12">
      <div className="max-w-lg w-full text-center">
        {/* Logo & Title */}
        <div className="mb-8">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[hsl(var(--cs-primary))] shadow-lg">
            <MessageCircle className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] mb-2">
            AgentForge 智能助手
          </h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            AI 驱动的知识助手，随时为您解答问题
          </p>
        </div>

        {/* Suggested Topics */}
        <div className="space-y-2 mb-6">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] flex items-center justify-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            试试这些话题
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(topics.length > 0 ? topics : DEFAULT_TOPICS).map((topic, i) => (
              <button
                key={i}
                onClick={() => onSend(topic.question)}
                className="flex items-center gap-2 rounded-xl border border-[hsl(var(--cs-border))] bg-white px-4 py-3 text-sm text-left text-[hsl(var(--foreground))] hover:border-[hsl(var(--cs-primary))] hover:bg-[hsl(var(--cs-primary))]/5 transition-all shadow-sm group"
              >
                <span className="flex-1">{topic.question}</span>
                <ArrowRight className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--cs-primary))] transition-colors" />
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          支持知识库查询、任务执行、工具调用等能力
        </p>
      </div>
    </div>
  );
}

const DEFAULT_TOPICS: FAQTopic[] = [
  { question: "你能做什么？", category: "能力介绍" },
  { question: "如何搜索知识库？", category: "使用指南" },
  { question: "如何联系人工客服？", category: "支持" },
  { question: "支持哪些工具？", category: "工具" },
];
