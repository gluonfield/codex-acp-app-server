import * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import {randomUUID} from "node:crypto";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {CodexAcpClient} from "./CodexAcpClient";
import type {SessionState} from "./CodexAcpServer";
import {CodexTurn} from "./CodexTurn";
import {scopedAcpConnection} from "./ScopedAcpConnection";
import {TurnTokenUsage, toPromptUsage} from "./TokenCount";
import {logger} from "./Logger";
import type {PromptCommand} from "./PromptCommand";

const SIDE_DEVELOPER_INSTRUCTIONS = `You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration without disrupting the main thread. The inherited fork history is reference context only; the next user message and its follow-ups are the active conversation.

Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly requests that mutation in this side conversation.`;

export interface SideChatScope {
    id: string;
    command: string;
    parentSessionId: string;
}

export interface SideChatPrompt {
    request: acp.PromptRequest;
    scope: SideChatScope;
}

interface SideChat {
    state: Promise<SideSession>;
    active: ActiveSidePrompt | null;
}

interface SideSession {
    state: SessionState;
    codex: CodexAcpClient;
}

interface ParentSideChats {
    closing: boolean;
    chats: Map<string, SideChat>;
}

interface SidePrompt {
    session: Promise<SideSession>;
    turnId: string | null;
    cancelled: boolean;
}

interface ActiveSidePrompt {
    prompt: SidePrompt;
    completion: Promise<acp.PromptResponse>;
}

export class SideChatManager {
    private readonly parents = new Map<string, ParentSideChats>();

    constructor(
        private readonly connection: AcpClientConnection,
        private readonly openClient: (parent: SessionState) => CodexAcpClient | Promise<CodexAcpClient>,
        private readonly clientCapabilities: () => acp.ClientCapabilities | null,
        private readonly run: <T>(operation: () => Promise<T>, client: CodexAcpClient) => Promise<T>,
    ) {}

    reset(): void {
        this.parents.clear();
    }

    async prompt(
        request: acp.PromptRequest,
        parent: SessionState,
        scope: SideChatScope,
        signal?: AbortSignal,
    ): Promise<acp.PromptResponse> {
        let parentChats = this.parents.get(parent.sessionId);
        if (parentChats?.closing) {
            throw RequestError.invalidRequest(undefined, "Parent session is closing");
        }
        if (!parentChats) {
            parentChats = {closing: false, chats: new Map()};
            this.parents.set(parent.sessionId, parentChats);
        }

        let chat = parentChats.chats.get(scope.id);
        const firstPrompt = chat === undefined;
        if (!chat) {
            chat = {state: this.createChat(parent), active: null};
            parentChats.chats.set(scope.id, chat);
        }
        if (chat.active) {
            throw RequestError.invalidRequest(undefined, "Side chat is already running");
        }
        const prompt: SidePrompt = {
            session: chat.state,
            turnId: null,
            cancelled: false,
        };
        const active: ActiveSidePrompt = {
            prompt,
            completion: this.runPrompt(
                request,
                parent.sessionId,
                scope,
                prompt,
                signal,
            ),
        };
        chat.active = active;
        try {
            const response = await active.completion;
            const {state} = await chat.state;
            return {
                ...response,
                _meta: {usageId: state.promptTokenUsage.id, codex: {sideChat: scope}},
            };
        } catch (error) {
            if (firstPrompt && parentChats.chats.get(scope.id) === chat) {
                parentChats.chats.delete(scope.id);
                if (!parentChats.closing) {
                    await chat.state.then(session => this.closeChat(session), () => undefined);
                }
            }
            throw error;
        } finally {
            if (chat.active === active) chat.active = null;
        }
    }

    async cancelParent(parentSessionId: string): Promise<void> {
        const chats = this.parents.get(parentSessionId)?.chats.values() ?? [];
        const active = [...chats].map(chat => chat.active).filter(value => value !== null);
        await Promise.all(active.map(value => this.interruptPrompt(value.prompt)));
    }

    async closeParent(parentSessionId: string): Promise<void> {
        const parent = this.parents.get(parentSessionId);
        if (!parent) return;
        parent.closing = true;
        const chats = [...parent.chats.values()];
        const active = chats.map(chat => chat.active).filter(value => value !== null);
        await Promise.all(active.map(value => this.interruptPrompt(value.prompt)));
        const sessions = await Promise.allSettled(chats.map(chat => chat.state));
        await Promise.allSettled(active.map(value => value.completion));
        parent.chats.clear();
        await Promise.all(sessions.filter(result => result.status === "fulfilled").map(result => this.closeChat(result.value)));
        if (this.parents.get(parentSessionId) === parent) {
            this.parents.delete(parentSessionId);
        }
    }

    private async createChat(parent: SessionState): Promise<SideSession> {
        const codex = await this.openClient(parent);
        const fork = await this.run(() => codex.forkSideSession(parent, SIDE_DEVELOPER_INSTRUCTIONS), codex);
        return {
            codex,
            state: {
                ...parent,
                sessionId: fork.sessionId,
                currentModelId: fork.currentModelId,
                currentTurnId: null,
                lastTokenUsage: null,
                promptTokenUsage: new TurnTokenUsage(),
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
        const {state, codex} = await prompt.session;
        if (signal?.aborted || prompt.cancelled) {
            return this.cancelled(state);
        }
        state.currentTurnId = null;
        state.lastTokenUsage = null;
        state.promptTokenUsage = new TurnTokenUsage();
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
        const turn = await CodexTurn.prepare(
            connection,
            codex,
            state,
            this.clientCapabilities(),
            operation => this.run(operation, codex),
            signal,
        );
        if (signal?.aborted || prompt.cancelled) return this.cancelled(state);

        const abort = () => void this.interruptPrompt(prompt);
        signal?.addEventListener("abort", abort, {once: true});
        try {
            const completed = await turn.send(
                {...request, sessionId: state.sessionId},
                turnId => {
                    prompt.turnId = turnId;
                    state.currentTurnId = turnId;
                    if (signal?.aborted || prompt.cancelled) void this.interruptPrompt(prompt);
                },
                () => prompt.cancelled || (signal?.aborted ?? false),
            );
            if (completed === null) return this.cancelled(state);
            await turn.drain();
            if (completed.turn.status === "interrupted") return this.cancelled(state);
            turn.throwIfFailed();
            return {
                stopReason: "end_turn",
                usage: state.promptTokenUsage.usage === null ? null : toPromptUsage(state.promptTokenUsage.usage),
            };
        } finally {
            signal?.removeEventListener("abort", abort);
            state.currentTurnId = null;
            prompt.turnId = null;
        }
    }

    private async interruptPrompt(prompt: SidePrompt): Promise<void> {
        prompt.cancelled = true;
        if (prompt.turnId === null) return;
        const turnId = prompt.turnId;
        prompt.turnId = null;
        try {
            const {state, codex} = await prompt.session;
            await codex.turnInterrupt({
                threadId: state.sessionId,
                turnId,
            });
        } catch (error) {
            logger.error("Failed to interrupt side chat", error);
        }
    }

    private async closeChat({state, codex}: SideSession): Promise<void> {
        try {
            await this.run(() => codex.closeSession(state.sessionId), codex);
        } catch (error) {
            logger.error(`Failed to close side chat ${state.sessionId}`, error);
        }
    }

    private cancelled(state: SessionState): acp.PromptResponse {
        return {
            stopReason: "cancelled",
            usage: state.promptTokenUsage.usage === null ? null : toPromptUsage(state.promptTokenUsage.usage),
        };
    }
}

export function parseSideChatPrompt(
    request: acp.PromptRequest,
    promptCommand: PromptCommand | null,
): SideChatPrompt | null {
    const meta = record(request._meta);
    const codex = record(meta?.["codex"]);
    const side = record(codex?.["sideChat"]);
    if (side) {
        const id = stringField(side, "id");
        if (!id) throw RequestError.invalidParams(undefined, "Side chat id is required");
        const command = stringField(side, "command") ?? "side";
        const parentSessionId = stringField(side, "parentSessionId") ?? request.sessionId;
        if (parentSessionId !== request.sessionId) {
            throw RequestError.invalidParams(undefined, "Side chat parentSessionId does not match sessionId");
        }
        return {request, scope: {id, command, parentSessionId}};
    }

    if (promptCommand?.name !== "side" && promptCommand?.name !== "btw") return null;
    if (!promptCommand.rest) {
        throw RequestError.invalidParams(undefined, `/${promptCommand.name} requires a question`);
    }
    const first = request.prompt[0];
    if (first?.type !== "text") return null;
    return {
        request: {
            ...request,
            prompt: [{...first, text: promptCommand.rest}, ...request.prompt.slice(1)],
        },
        scope: {
            id: `side_${randomUUID()}`,
            command: promptCommand.name,
            parentSessionId: request.sessionId,
        },
    };
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
