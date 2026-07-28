import {
  MessageCircle,
  AlertTriangle,
  Code,
  Settings,
  TrendingUp,
  Shield,
} from "lucide-react";

interface FAQTopic {
  icon: React.ReactNode;
  title: string;
  questions: string[];
  color: string;
}

const FAQ_TOPICS: FAQTopic[] = [
  {
    icon: <AlertTriangle className="h-5 w-5" />,
    title: "错误码排查",
    questions: [
      "FACE_TIMEOUT 怎么排查？",
      "LIVENESS_FAIL 是什么原因？",
      "CAMERA_PERMISSION_DENIED 如何解决？",
    ],
    color: "bg-red-50 text-red-600 border-red-200",
  },
  {
    icon: <Code className="h-5 w-5" />,
    title: "SDK 集成",
    questions: [
      "H5 接入 SDK 需要注意什么？",
      "小程序 SDK 如何配置权限？",
      "SDK 版本过旧如何处理？",
    ],
    color: "bg-blue-50 text-blue-600 border-blue-200",
  },
  {
    icon: <Settings className="h-5 w-5" />,
    title: "接入配置",
    questions: [
      "商户核身如何接入？",
      "安全等级怎么选择？",
      "回调地址如何配置？",
    ],
    color: "bg-purple-50 text-purple-600 border-purple-200",
  },
  {
    icon: <TrendingUp className="h-5 w-5" />,
    title: "通过率优化",
    questions: [
      "通过率下降了怎么办？",
      "如何校准活体通过率基线？",
      "如何提升核身通过率？",
    ],
    color: "bg-green-50 text-green-600 border-green-200",
  },
  {
    icon: <Shield className="h-5 w-5" />,
    title: "应急响应",
    questions: [
      "批量失败如何应急处理？",
      "网络超时怎么排查？",
      "如何查看监控告警？",
    ],
    color: "bg-amber-50 text-amber-600 border-amber-200",
  },
];

interface WelcomeScreenProps {
  onSend: (message: string) => void;
}

export function WelcomeScreen({ onSend }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center px-3 sm:px-6 py-6 sm:py-12 animate-fade-in">
      {/* 头部 */}
      <div className="flex h-12 w-12 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-[hsl(var(--cs-primary))] shadow-lg mb-3 sm:mb-5">
        <MessageCircle className="h-6 w-6 sm:h-8 sm:w-8 text-white" />
      </div>
      <h2 className="text-lg sm:text-xl font-bold text-[hsl(var(--foreground))] mb-1 text-center">
        您好，欢迎来到核身排障助手
      </h2>
      <p className="text-xs sm:text-sm text-[hsl(var(--muted-foreground))] mb-4 sm:mb-8 text-center">
        请选择您想咨询的核身问题类型，或直接输入您的问题
      </p>

      {/* FAQ 话题卡片 */}
      <div className="grid w-full max-w-2xl grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3">
        {FAQ_TOPICS.map((topic) => (
          <div
            key={topic.title}
            className={`rounded-xl border p-3 sm:p-4 transition-all duration-200 hover:shadow-md active:scale-[0.98] cursor-pointer ${topic.color}`}
          >
            <div className="flex items-center gap-2 mb-3">
              {topic.icon}
              <span className="text-sm font-semibold">{topic.title}</span>
            </div>
            <div className="space-y-1.5">
              {topic.questions.map((q) => (
                <button
                  key={q}
                  onClick={() => onSend(q)}
                  className="block w-full text-left text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors py-0.5"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-xs text-[hsl(var(--muted-foreground))]">
        基于核身知识库提供诊断建议，重要问题请联系技术支持
      </p>
    </div>
  );
}
