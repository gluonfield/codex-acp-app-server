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

interface SidePrompt {
    chat: SideChat;
    turnId: string | null;
    cancelled: boolean;
}

interface ActiveSidePrompt {
    prompt: SidePrompt;
    completion: Promise<acp.PromptResponse>;
}

export class SideChatManager {
    private readonly chats = new Map<string, Promise<SideChat>>();
    private readonly active = new Map<string, ActiveSidePrompt>();
    private readonly closingParents = new Set<string>();

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
        if (this.closingParents.has(parent.sessionId)) {
            throw RequestError.invalidRequest(undefined, "Parent session is closing");
        }
        if (this.active.has(key)) {
            throw RequestError.invalidRequest(undefined, "Side chat is already running");
        }

        let chatPromise = this.chats.get(key);
        const firstPrompt = chatPromise === undefined;
        if (chatPromise === undefined) {
            chatPromise = this.createChat(parent);
            this.chats.set(key, chatPromise);
        }

        let chat: SideChat;
        try {
            chat = await chatPromise;
        } catch (error) {
            if (this.chats.get(key) === chatPromise) this.chats.delete(key);
            throw error;
        }
        if (this.closingParents.has(parent.sessionId)) {
            return this.cancelled(chat.state);
        }
        if (this.active.has(key)) {
            throw RequestError.invalidRequest(undefined, "Side chat is already running");
        }

        const prompt: SidePrompt = {
            chat,
            turnId: null,
            cancelled: false,
        };
        const active: ActiveSidePrompt = {
            prompt,
            completion: this.runPrompt(
                firstPrompt ? withSideBoundary(request) : request,
                parent.sessionId,
                scope,
                prompt,
                signal,
            ),
        };
        this.active.set(key, active);
        try {
            return await active.completion;
        } catch (error) {
            if (firstPrompt && this.chats.get(key) === chatPromise) {
                this.chats.delete(key);
                if (!this.closingParents.has(parent.sessionId)) await this.closeChat(chat);
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
        this.closingParents.add(parentSessionId);
        const pending = [...this.chats.entries()]
            .filter(([key]) => key.startsWith(`${parentSessionId}\0`));
        const entries = (await Promise.all(pending.map(async ([key, chat]) => {
            try {
                return [key, await chat] as const;
            } catch {
                return null;
            }
        }))).filter(entry => entry !== null);
        const keys = new Set(pending.map(([key]) => key));
        const active = [...this.active.entries()]
            .filter(([key]) => keys.has(key))
            .map(([, value]) => value);
        await Promise.all(active.map(value => this.interrupt(value)));
        await Promise.allSettled(active.map(value => value.completion));
        for (const [key, chat] of pending) {
            if (this.chats.get(key) === chat) this.chats.delete(key);
        }
        await Promise.all(entries.map(([, chat]) => this.closeChat(chat)));
    }

    finishParentClose(parentSessionId: string): void {
        this.closingParents.delete(parentSessionId);
    }

    private async createChat(parent: SessionState): Promise<SideChat> {
        const fork = await this.run(() => this.codex.forkSideSession(parent, SIDE_DEVELOPER_INSTRUCTIONS));
        return {
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
    }

    private async runPrompt(
        request: acp.PromptRequest,
        parentSessionId: string,
        scope: SideChatScope,
        prompt: SidePrompt,
        signal?: AbortSignal,
    ): Promise<acp.PromptResponse> {
        const state = prompt.chat.state;
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
        if (signal?.aborted || prompt.cancelled) return this.cancelled(state);
        if (!state.supportedInputModalities.includes("image")
            && request.prompt.some(block => block.type === "image")) {
            throw RequestError.invalidRequest("The current model does not support image input");
        }

        const abort = () => void this.interruptPrompt(prompt);
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
                    prompt.turnId = turnId;
                    state.currentTurnId = turnId;
                    if (signal?.aborted || prompt.cancelled) void this.interruptPrompt(prompt);
                },
                () => prompt.cancelled || (signal?.aborted ?? false),
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
            prompt.turnId = null;
        }
    }

    private async interrupt(active: ActiveSidePrompt): Promise<void> {
        await this.interruptPrompt(active.prompt);
    }

    private async interruptPrompt(prompt: SidePrompt): Promise<void> {
        prompt.cancelled = true;
        if (prompt.turnId === null) return;
        const turnId = prompt.turnId;
        prompt.turnId = null;
        try {
            await this.codex.turnInterrupt({
                threadId: prompt.chat.state.sessionId,
                turnId,
            });
        } catch (error) {
            logger.error(`Failed to interrupt side chat ${prompt.chat.state.sessionId}`, error);
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
