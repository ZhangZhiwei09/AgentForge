// 知识库入口页面 —— 两卡片导航入口
import { useNavigate } from "react-router-dom";
import { Database, FlaskConical } from "lucide-react";

export function KnowledgePage() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col flex-1 h-full bg-[hsl(var(--background))] items-center justify-center">
      {/* 页面标题 */}
      <div className="space-y-2 mb-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">知识库</h1>
        <p className="text-sm text-muted-foreground">
          管理知识库文档与检索测试
        </p>
      </div>

      {/* 导航卡片 */}
      <div className="grid grid-cols-2 gap-4 w-full max-w-lg">
        {/* 知识库管理卡片 */}
        <div
          onClick={() => navigate("/admin/cs/knowledge/bases")}
          className="cursor-pointer rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--ring))]/50 hover:shadow-md"
        >
          <div className="rounded-lg bg-[hsl(var(--primary))]/10 p-2.5 w-fit mb-3">
            <Database className="h-5 w-5 text-[hsl(var(--primary))]" />
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">
            知识库管理
          </h3>
          <p className="text-xs text-muted-foreground">
            创建和管理知识库，上传文档并配置分块策略
          </p>
        </div>

        {/* 检索调试卡片 */}
        <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 opacity-70">
          <div className="rounded-lg bg-amber-50 p-2.5 w-fit mb-3">
            <FlaskConical className="h-5 w-5 text-amber-500" />
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">
            检索调试
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            进入具体知识库后，可进行命中测试和检索调优
          </p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate("/admin/cs/knowledge/bases");
            }}
            className="text-xs text-[hsl(var(--primary))] hover:underline"
          >
            选择知识库 &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
