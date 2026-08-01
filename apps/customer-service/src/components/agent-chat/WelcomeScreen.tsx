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
    <div className="flex items-center justify-center min-h-full px-4 py-12">
      <div className="max-w-lg w-full text-center">
        {/* Logo & Title */}
        <div className="mb-8">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[hsl(var(--cs-primary))] shadow-lg">
            <MessageCircle className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] mb-2">
            核身排障智能助手
          </h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            基于知识库为您提供核身错误码排查、SDK 集成诊断与通过率优化建议
          </p>
        </div>

        {/* Suggested Topics */}
        <div className="space-y-2 mb-6">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] flex items-center justify-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            试试这些话题
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DEFAULT_TOPICS.map((topic, i) => (
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
