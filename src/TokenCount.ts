import type {UpdateSessionEvent} from "./ACPSessionConnection";
import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

/**
 * Token usage information for a turn.
 * This interface decouples our API from Codex's internal types.
 *
 * [totalTokens]: inputTokens + cachedInputTokens + outputTokens
 * [inputTokens]: number of non-cached input tokens
 * [cachedInputTokens]: number of cached input tokens
 * [outputTokens]: number of output tokens (including reasoning output tokens)
 * [reasoningOutputTokens]: number of reasoning output tokens
 */
export interface TokenCount {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

export class PromptTokenUsage {
    id: string | null = null;
    private turnId: string | null = null;
    private previousTotal: number | null = null;
    usage: TokenCount | null = null;

    start(turnId: string): void {
        if (turnId === this.turnId) {
            return;
        }
        this.id ??= turnId;
        this.turnId = turnId;
        this.previousTotal = null;
    }

    record(turnId: string, last: TokenCount, total: TokenCount): void {
        if (turnId !== this.turnId || total.totalTokens === this.previousTotal) {
            return;
        }
        if (last.inputTokens + last.cachedInputTokens + last.outputTokens === 0) {
            return;
        }
        this.previousTotal = total.totalTokens;
        const current = this.usage;
        this.usage = {
            inputTokens: (current?.inputTokens ?? 0) + last.inputTokens,
            cachedInputTokens: (current?.cachedInputTokens ?? 0) + last.cachedInputTokens,
            outputTokens: (current?.outputTokens ?? 0) + last.outputTokens,
            reasoningOutputTokens: (current?.reasoningOutputTokens ?? 0) + last.reasoningOutputTokens,
            totalTokens: (current?.totalTokens ?? 0) + last.totalTokens,
        };
    }
}

/**
 * Maps Codex's TokenUsageBreakdown to our TokenCount interface.
 * This explicit mapping ensures compile-time errors if Codex changes their types.
 * Note: Codex includes cached input tokens in the input token count, so they are subtracted here.
 */
export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {

    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens - usage.cachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

/**
 * Maps our per-turn token breakdown to ACP PromptResponse usage fields.
 * Cached input tokens are reported as ACP cache reads, and reasoning output
 * tokens are exposed through ACP's thoughtTokens field.
 */
export function toPromptUsage(tokenCount: TokenCount): Usage {
    return {
        totalTokens: tokenCount.totalTokens,
        inputTokens: tokenCount.inputTokens,
        cachedReadTokens: tokenCount.cachedInputTokens,
        outputTokens: tokenCount.outputTokens,
        thoughtTokens: tokenCount.reasoningOutputTokens,
    };
}

export function usageUpdate(tracker: PromptTokenUsage, last: TokenCount, size: number | null): UpdateSessionEvent | null {
    const meta = tracker.usage === null ? undefined : {usageId: tracker.id, usage: toPromptUsage(tracker.usage)};
    if (size === null || size <= 0) {
        return meta === undefined ? null : {sessionUpdate: "session_info_update", _meta: meta};
    }
    return {
        sessionUpdate: "usage_update",
        used: last.totalTokens,
        size,
        ...(meta === undefined ? {} : {_meta: meta}),
    };
}
