// App Creation 模块入口 —— 导出标准 ServerModule 接口
import type { ServerModule } from "../types.js";
import { appCreationRoutes } from "./routes.js";

export const appCreationModule: ServerModule = {
  name: "app-creation",
  routes: appCreationRoutes,
};
