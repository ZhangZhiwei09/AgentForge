// @agentforge/cui Tailwind 配置
// 组件库内颜色由 CVA 管理，此处仅定义 content 扫描路径。
// 消费方需要在自身的 tailwind.config.ts 中添加此包的 src 路径。
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
