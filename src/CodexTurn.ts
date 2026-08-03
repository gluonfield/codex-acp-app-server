import * as acp from "@agentclientprotocol/sdk";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {CodexEventHandler, type CompletedPlan} from "./CodexEventHandler";
import type {SessionState} from "./CodexAcpServer";
import type {TurnCompletedNotification} from "./app-server/v2";
import {resolveFastServiceTier} from "./FastModeConfig";
import {logger} from "./Logger";
import {ModelId} from "./ModelId";
import {clientSupportsPlanUpdates} from "./PlanCapabilities";

export class CodexTurn {
    private constructor(
        private readonly codex: CodexAcpClient,
        private readonly state: SessionState,
        private readonly events: CodexEventHandler,
        private readonly run: <T>(operation: () => Promise<T>) => Promise<T>,
    ) {}

    static async prepare(
        connection: AcpClientConnection,
        codex: CodexAcpClient,
        state: SessionState,
        clientCapabilities: acp.ClientCapabilities | null,
        run: <T>(operation: () => Promise<T>) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<CodexTurn> {
        const events = new CodexEventHandler(
            connection,
            state,
            clientSupportsPlanUpdates(clientCapabilities),
        );
        const approvals = new CodexApprovalHandler(connection, state, signal);
        const elicitations = new CodexElicitationHandler(
            connection,
            state,
            clientCapabilities,
            signal,
        );
        await codex.subscribeToSessionEvents(
            state.sessionId,
            async event => {
                await elicitations.handleNotification(event);
                await events.handleNotification(event);
            },
            approvals,
            elicitations,
        );
        return new CodexTurn(codex, state, events, run);
    }

    send(
        request: acp.PromptRequest,
        onTurnStarted: (turnId: string) => void,
        shouldCancel: () => boolean,
    ): Promise<TurnCompletedNotification | null> {
        if (this.state.supportedInputModalities !== null
            && !this.state.supportedInputModalities.includes("image")
            && request.prompt.some(block => block.type === "image")) {
            throw acp.RequestError.invalidRequest("The current model does not support image input");
        }
        const model = ModelId.fromString(this.state.currentModelId);
        const lacksReasoning = this.state.supportedReasoningEfforts.length > 0
            && this.state.supportedReasoningEfforts.every(effort => effort.reasoningEffort === "none");
        const disableSummary = this.state.account?.type === "apiKey" || lacksReasoning;
        if (disableSummary) {
            logger.log("Disable reasoning.summary", {
                sessionId: this.state.sessionId,
                reason: this.state.account?.type === "apiKey" ? "API key" : "model lacks reasoning",
            });
        }
        return this.run(() => this.codex.sendPrompt(
            request,
            this.state.agentMode,
            model,
            resolveFastServiceTier(
                this.state.fastModeEnabled,
                this.state.currentModelSupportsFast,
            ),
            disableSummary,
            this.state.cwd,
            this.state.additionalDirectories,
            onTurnStarted,
            shouldCancel,
        ));
    }

    async drain(): Promise<void> {
        await this.codex.waitForSessionNotifications(this.state.sessionId);
    }

    throwIfFailed(): void {
        const failure = this.events.getFailure();
        if (failure) throw failure;
    }

    flushPendingPlanUpdates(): Promise<void> {
        return this.events.flushPendingPlanUpdates();
    }

    takeCompletedPlan(): CompletedPlan | null {
        return this.events.takeCompletedPlan();
    }

    dispose(): Promise<void> {
        return this.events.dispose();
    }
}
