import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHono } from "../lib/hono.js";
import { diagnosisService } from "../services/diagnosis/index.js";

export const diagnosisRoutes = createHono();

const diagnosisQueryRequestSchema = z.object({
  query: z.string().trim().min(1),
  kbIds: z.array(z.string().min(1)).optional(),
  sessionId: z.string().optional(),
});

diagnosisRoutes.post(
  "/api/diagnosis/query",
  zValidator("json", diagnosisQueryRequestSchema),
  async (c) => {
    const { query, kbIds } = c.req.valid("json");
    const result = await diagnosisService.run({ query, kbIds });
    return c.json(result);
  },
);

