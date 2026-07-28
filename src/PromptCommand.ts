import type * as acp from "@agentclientprotocol/sdk";

export interface PromptCommand {
    name: string;
    rest: string;
}

export function parsePromptCommand(prompt: acp.ContentBlock[]): PromptCommand | null {
    const first = prompt[0];
    if (first?.type !== "text") return null;

    const text = first.text.trim();
    if (!text.startsWith("/")) return null;

    const commandText = text.slice(1).trim();
    const [name] = commandText.split(/\s+/);
    if (!name) return null;

    return {
        name: name.toLowerCase(),
        rest: commandText.slice(name.length).trim(),
    };
}
