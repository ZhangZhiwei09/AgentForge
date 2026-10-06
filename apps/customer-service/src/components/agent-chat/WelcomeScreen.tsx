import { MessageCircle, Sparkles, ArrowRight } from "lucide-react";

interface FAQTopic {
  question: string;
  category: string;
}

interface WelcomeScreenProps {
  onSend: (question: string) => void;
}

export function WelcomeScreen({ onSend }: WelcomeScreenProps) {

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="max-w-lg w-full text-center">
        {/* Logo & Title */}
        <div className="mb-8">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--cs-primary))] shadow-[0_12px_26px_hsl(var(--cs-primary)/25%)]">
            <MessageCircle className="h-8 w-8 text-white" />
          </div>
          <h1 className="mb-2 text-2xl font-bold text-[hsl(var(--foreground))]">
            开始一个排障会话
          </h1>
          <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">
            基于知识库为您提供核身错误码排查、SDK 集成诊断与通过率优化建议
          </p>
        </div>

        {/* Suggested Topics */}
        <div className="space-y-2 mb-6">
          <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))]">
            <Sparkles className="h-3 w-3" />
            试试这些话题
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DEFAULT_TOPICS.map((topic, i) => (
              <button
                key={i}
                onClick={() => onSend(topic.question)}
                className="group flex items-center gap-3 rounded-xl border border-[hsl(var(--cs-border))] bg-white px-4 py-3 text-left text-sm text-[hsl(var(--foreground))] shadow-sm transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--cs-primary))] hover:bg-[hsl(var(--cs-primary))]/5 hover:shadow-md"
              >
                <span className="flex-1">{topic.question}</span>
                <ArrowRight className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--cs-primary))] transition-colors" />
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          支持核身错误码排查、SDK 集成诊断、通过率分析等能力
        </p>
      </div>
    </div>
  );
}

const DEFAULT_TOPICS: FAQTopic[] = [
  { question: "FACE_TIMEOUT 错误怎么排查？", category: "错误码排查" },
  { question: "活体检测失败是什么原因？", category: "错误码排查" },
  { question: "SDK 版本过旧如何处理？", category: "SDK 集成" },
  { question: "摄像头权限被拒绝怎么解决？", category: "错误码排查" },
  { question: "如何提升核身通过率？", category: "通过率优化" },
  { question: "H5 接入核身 SDK 需要注意什么？", category: "SDK 集成" },
];
