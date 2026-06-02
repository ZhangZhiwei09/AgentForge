export interface Prompt {
    id: string;
    name: string;
    content: string;
    version: string;
    tags: string[];
}

export const system_prompt: Prompt = {
    id: "system-default",
    name: "Default System Prompt",
    version: "1.0.0",
    tags: ["system", "default"],
    content: `You are a helpful AI assistant. Provide clear, accurate, and well-structured responses.

Guidelines:
- Answer questions directly and concisely
- Use markdown formatting for structured responses
- Include code examples when relevant
- Admit when you don't know something
- Ask clarifying questions when the user's intent is unclear`,
};

export const chat_prompt_template = (user_message: string): string => {
    return user_message;
};

export function getPrompt(id: string): Prompt | undefined {
    return registry[id];
}

export function listPrompts(): Prompt[] {
    return Object.values(registry);
}

const registry: Record<string, Prompt> = {
    [system_prompt.id]: system_prompt,
};
