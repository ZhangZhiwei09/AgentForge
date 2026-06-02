import type { LLMProviderInfo } from "@agentforge/shared-types";
import type { AgentForgeClient } from "../client";

export class ProviderService {
    constructor(private client: AgentForgeClient) { }

    list() {
        return this.client.listProviders();
    }
}
