// 通用加载指示器
export function LoadingSpinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClass = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-12 w-12" : "h-8 w-8";
  return (
    <div className="flex items-center justify-center">
      <div className={`animate-spin ${sizeClass} border-3 border-blue-600 border-t-transparent rounded-full`} />
    </div>
  );
}
