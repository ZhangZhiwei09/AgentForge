import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  splitting: false,
  // 仅打包 workspace 包（解决 .ts 源文件问题）
  // 其他 npm 包保持 external，CJS 格式下 require() 调用正常
  noExternal: [/@agentforge/],
  // 原生模块和含原生引引擎的包不打包
  external: [/@node-rs/, /@prisma/],
  // .cjs 避免与 package.json "type":"module" 冲突
  outExtension: () => ({ js: ".cjs" }),
});
