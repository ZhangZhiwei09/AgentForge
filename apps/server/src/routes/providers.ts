import { Hono } from "hono";
import { listProviders } from "../providers/registry.js";

export const providerRoutes = new Hono();

// GET /api/providers
providerRoutes.get("/api/providers", (c) => {
  return c.json(listProviders());
});
