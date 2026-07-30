import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "./ACPSessionConnection";

type AcpMeta = Record<string, unknown>;

export function createCodexMessagePhaseMeta(phase: string | null | undefined): AcpMeta | undefined {
    if (!phase) {
        return undefined;
    }
    return { codex: { phase } };
}

export function createUserMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "user_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "user_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentThoughtChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_thought_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentTextMessageChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentMessageChunk({type: "text", text}, messageId, meta);
}

export function createAgentTextThoughtChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentThoughtChunk({type: "text", text}, messageId, meta);
}

type CodexAgentChunk = {
    content: ContentBlock;
    phase: string | null | undefined;
    turnId?: string | undefined;
    itemId?: string | undefined;
};

export function createCodexAgentChunk({
    content,
    phase,
    turnId,
    itemId,
}: CodexAgentChunk): UpdateSessionEvent {
    const meta = createCodexMessagePhaseMeta(phase);
    return phase === "commentary"
        ? createAgentThoughtChunk(content, turnId, meta)
        : createAgentMessageChunk(content, itemId, meta);
}
