import * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {CodexAcpClient} from "./CodexAcpClient";
import type {SessionState} from "./CodexAcpServer";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {CodexEventHandler} from "./CodexEventHandler";
import {ModelId} from "./ModelId";
import {resolveFastServiceTier} from "./FastModeConfig";
import {scopedAcpConnection} from "./ScopedAcpConnection";
import {toPromptUsage} from "./TokenCount";
import {logger} from "./Logger";

const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages after this boundary are active user instructions for this side conversation.`;

const SIDE_DEVELOPER_INSTRUCTIONS = `You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration without disrupting the main thread. The inherited fork history is reference context only; only instructions submitted after the side-conversation boundary are active.

Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly requests that mutation in this side conversation.`;

export interface SideChatScope {
    id: string;
    command: string;
    parentSessionId: string;
}

interface SideChat {
    state: SessionState;
}

interface ActiveSidePrompt {
    chat: SideChat;
    turnId: string | null;
    completion: Promise<acp.PromptResponse>;
}

export class SideChatManager {
    private readonly chats = new Map<string, SideChat>();
    private readonly active = new Map<string, ActiveSidePrompt>();

    constructor(
        private readonly connection: AcpClientConnection,
        private readonly codex: CodexAcpClient,
        private readonly clientCapabilities: () => acp.ClientCapabilities | null,
        private readonly run: <T>(operation: () => Promise<T>) => Promise<T>,
    ) {}

    async prompt(
        request: acp.PromptRequest,
        parent: SessionState,
        scope: SideChatScope,
        signal?: AbortSignal,
    ): Promise<acp.PromptResponse> {
        const key = sideChatKey(parent.sessionId, scope.id);
        if (this.active.has(key)) {
            throw RequestError.invalidRequest(undefined, "Side chat is already running");
        }

        let chat = this.chats.get(key);
        let firstPrompt = false;
        if (!chat) {
            const fork = await this.run(() => this.codex.forkSideSession(
                parent.sessionId,
                SIDE_DEVELOPER_INSTRUCTIONS,
            ));
            chat = {
                state: {
                    ...parent,
                    sessionId: fork.sessionId,
                    currentModelId: fork.currentModelId,
                    currentTurnId: null,
                    lastTokenUsage: null,
                    totalTokenUsage: null,
                    rateLimits: null,
                    currentGoal: null,
                    goalRevision: 0,
                },
            };
            this.chats.set(key, chat);
            firstPrompt = true;
        }

        const active: ActiveSidePrompt = {
            chat,
            turnId: null,
            completion: Promise.resolve({stopReason: "cancelled"}),
        };
        active.completion = this.runPrompt(
            firstPrompt ? withSideBoundary(request) : request,
            parent.sessionId,
            scope,
            active,
            signal,
        );
        this.active.set(key, active);
        try {
            return await active.completion;
        } catch (error) {
            if (firstPrompt) {
                this.chats.delete(key);
                await this.closeChat(chat);
            }
            throw error;
        } finally {
            if (this.active.get(key) === active) this.active.delete(key);
        }
    }

    async cancelParent(parentSessionId: string): Promise<void> {
        await Promise.all(
            [...this.active.entries()]
                .filter(([key]) => key.startsWith(`${parentSessionId}\0`))
                .map(([, active]) => this.interrupt(active)),
        );
    }

    async closeParent(parentSessionId: string): Promise<void> {
        const entries = [...this.chats.entries()]
            .filter(([key]) => key.startsWith(`${parentSessionId}\0`));
        const keys = new Set(entries.map(([key]) => key));
        const active = [...this.active.entries()]
            .filter(([key]) => keys.has(key))
            .map(([, value]) => value);
        await Promise.all(active.map(value => this.interrupt(value)));
        await Promise.allSettled(active.map(value => value.completion));
        for (const [key] of entries) this.chats.delete(key);
        await Promise.all(entries.map(([, chat]) => this.closeChat(chat)));
    }

    private async runPrompt(
        request: acp.PromptRequest,
        parentSessionId: string,
        scope: SideChatScope,
        active: ActiveSidePrompt,
        signal?: AbortSignal,
    ): Promise<acp.PromptResponse> {
        const state = active.chat.state;
        state.currentTurnId = null;
        state.lastTokenUsage = null;
        const connection = scopedAcpConnection(this.connection, parentSessionId, {
            codex: {
                sideChat: {
                    id: scope.id,
                    command: scope.command,
                    parentSessionId,
                    threadId: state.sessionId,
                },
            },
        });
        const eventHandler = new CodexEventHandler(connection, state);
        const approvalHandler = new CodexApprovalHandler(connection, state, signal);
        const elicitationHandler = new CodexElicitationHandler(
            connection,
            state,
            this.clientCapabilities(),
            signal,
        );
        await this.codex.subscribeToSessionEvents(
            state.sessionId,
            async event => {
                await elicitationHandler.handleNotification(event);
                await eventHandler.handleNotification(event);
            },
            approvalHandler,
            elicitationHandler,
        );
        if (signal?.aborted) return this.cancelled(state);
        if (!state.supportedInputModalities.includes("image")
            && request.prompt.some(block => block.type === "image")) {
            throw RequestError.invalidRequest("The current model does not support image input");
        }

        const abort = () => void this.interrupt(active);
        signal?.addEventListener("abort", abort, {once: true});
        try {
            const modelId = ModelId.fromString(state.currentModelId);
            const modelLacksReasoning = state.supportedReasoningEfforts.length > 0
                && state.supportedReasoningEfforts.every(effort => effort.reasoningEffort === "none");
            const completed = await this.run(() => this.codex.sendPrompt(
                {...request, sessionId: state.sessionId},
                state.agentMode,
                modelId,
                resolveFastServiceTier(state.fastModeEnabled, state.currentModelSupportsFast),
                state.account?.type === "apiKey" || modelLacksReasoning,
                state.cwd,
                state.additionalDirectories,
                turnId => {
                    active.turnId = turnId;
                    state.currentTurnId = turnId;
                    if (signal?.aborted) void this.interrupt(active);
                },
                () => signal?.aborted ?? false,
            ));
            if (completed === null) return this.cancelled(state);
            await this.codex.waitForSessionNotifications(state.sessionId);
            if (completed.turn.status === "interrupted") return this.cancelled(state);
            const failure = eventHandler.getFailure();
            if (failure) throw failure;
            return {
                stopReason: "end_turn",
                usage: state.lastTokenUsage === null ? null : toPromptUsage(state.lastTokenUsage),
            };
        } finally {
            signal?.removeEventListener("abort", abort);
            state.currentTurnId = null;
            active.turnId = null;
        }
    }

    private async interrupt(active: ActiveSidePrompt): Promise<void> {
        if (active.turnId === null) return;
        const turnId = active.turnId;
        active.turnId = null;
        try {
            await this.codex.turnInterrupt({
                threadId: active.chat.state.sessionId,
                turnId,
            });
        } catch (error) {
            logger.error(`Failed to interrupt side chat ${active.chat.state.sessionId}`, error);
        }
    }

    private async closeChat(chat: SideChat): Promise<void> {
        try {
            await this.run(() => this.codex.closeSession(chat.state.sessionId));
        } catch (error) {
            logger.error(`Failed to close side chat ${chat.state.sessionId}`, error);
        }
    }

    private cancelled(state: SessionState): acp.PromptResponse {
        return {
            stopReason: "cancelled",
            usage: state.lastTokenUsage === null ? null : toPromptUsage(state.lastTokenUsage),
        };
    }

}

export function parseSideChatScope(request: acp.PromptRequest): SideChatScope | null {
    const meta = record(request._meta);
    const codex = record(meta?.["codex"]);
    const side = record(codex?.["sideChat"]);
    if (!side) return null;

    const id = stringField(side, "id");
    if (!id) throw RequestError.invalidParams(undefined, "Side chat id is required");
    const command = stringField(side, "command") ?? "side";
    const parentSessionId = stringField(side, "parentSessionId") ?? request.sessionId;
    if (parentSessionId !== request.sessionId) {
        throw RequestError.invalidParams(undefined, "Side chat parentSessionId does not match sessionId");
    }
    return {id, command, parentSessionId};
}

function withSideBoundary(request: acp.PromptRequest): acp.PromptRequest {
    const prompt = [...request.prompt];
    const index = prompt.findIndex(block => block.type === "text");
    if (index < 0) throw RequestError.invalidParams(undefined, "Side chat requires a text question");
    const block = prompt[index] as acp.ContentBlock & {type: "text"; text: string};
    const question = block.text.trim();
    if (!question) throw RequestError.invalidParams(undefined, "Side chat requires a question");
    prompt[index] = {
        ...block,
        text: `${SIDE_BOUNDARY_PROMPT}\n\nSide conversation question:\n${question}`,
    };
    return {...request, prompt};
}

function sideChatKey(parentSessionId: string, id: string): string {
    return `${parentSessionId}\0${id}`;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
    const field = value[key];
    if (typeof field !== "string") return null;
    const trimmed = field.trim();
    return trimmed || null;
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}
