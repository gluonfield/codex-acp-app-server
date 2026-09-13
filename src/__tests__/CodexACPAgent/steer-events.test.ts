import {beforeEach, describe, expect, it, vi} from 'vitest';
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import type {TurnCompletedNotification} from "../../app-server/v2";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";

function createTurn(id: string, status: "inProgress" | "completed" | "interrupted" | "failed") {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: status === "failed" ? {message: "provider failure", codexErrorInfo: "usageLimitExceeded" as const, additionalDetails: null, misalignment: null} : null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

/**
 * Drives a prompt to the point where a turn is active (in progress) and paused
 * on turn completion, so a steer can be injected mid-turn.
 */
function startActiveTurn(sessionOverrides?: Partial<SessionState>) {
    const mockFixture = createCodexMockTestFixture();
    const sessionState = createTestSessionState(sessionOverrides);
    vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({
        turn: createTurn("turn-id", "inProgress"),
    });
    const turnCompleted = deferred<TurnCompletedNotification>();
    vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockReturnValue(turnCompleted.promise);
    vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    return {mockFixture, sessionState, turnCompleted};
}

describe('_session/steering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('advertises completion-aware native steering', async () => {
        const mockFixture = createCodexMockTestFixture();

        const response = await mockFixture.getCodexAcpAgent().initialize({protocolVersion: 1});

        expect(response._meta?.["steering"]).toEqual({supported: true, waitForCompletion: true});
    });

    it('reports injected when the input joins the active turn', async () => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn();
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "turn-id"});

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "also keep backward compatibility"}],
        })).resolves.toEqual({outcome: "injected"});

        expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            expectedTurnId: "turn-id",
            input: [{type: "text", text: "also keep backward compatibility", text_elements: []}],
        });

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it.each(["completed", "interrupted", "failed"] as const)('preserves %s completion for an injected steer', async (status) => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "turn-id"});

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "native follow-up"}],
            waitForCompletion: true,
        });
        let settled = false;
        void steerPromise.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        const turn = createTurn("turn-id", status)
        if (turn.error) {
            mockFixture.sendServerNotification({
                method: "error",
                params: {threadId: "session-id", turnId: turn.id, willRetry: false, error: turn.error},
            })
        }
        turnCompleted.resolve({threadId: "session-id", turn})
        const results = await Promise.allSettled([promptPromise, steerPromise])
        if (status === "failed") {
            for (const result of results) {
                expect(result).toMatchObject({status: "rejected", reason: {code: -32603, data: {message: "provider failure"}}})
            }
        } else {
            const stopReason = status === "interrupted" ? "cancelled" : "end_turn"
            expect(results[0]).toMatchObject({status: "fulfilled", value: {stopReason}})
            expect(results[1]).toEqual({status: "fulfilled", value: {outcome: "injected", stopReason}})
        }
    });

    it('retains the result when the turn completes before steering is acknowledged', async () => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn()
        const acknowledgement = deferred<{turnId: string}>()
        const turnSteer = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockReturnValue(acknowledgement.promise)
        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        })
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id")
        })
        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "racing follow-up"}],
            waitForCompletion: true,
        })
        await vi.waitFor(() => {
            expect(turnSteer).toHaveBeenCalled()
        })
        turnCompleted.resolve({threadId: "session-id", turn: createTurn("turn-id", "interrupted")})
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"})
        acknowledgement.resolve({turnId: "turn-id"})
        await expect(steerPromise).resolves.toEqual({outcome: "injected", stopReason: "cancelled"})
    })

    it('starts a new turn when no turn is active', async () => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        const turnStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "too late for the previous turn"}],
        })).resolves.toEqual({outcome: "startedNewTurn"});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "session-id",
            input: [{type: "text", text: "too late for the previous turn", text_elements: []}],
        }));

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBeNull();
        });
    });

    it.each(["completed", "interrupted", "failed"] as const)('preserves %s completion for a late steer', async (status) => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);

        const steerPromise = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "late native follow-up"}],
            waitForCompletion: true,
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("new-turn-id");
        });
        let settled = false;
        void steerPromise.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        const turn = createTurn("new-turn-id", status)
        if (turn.error) {
            mockFixture.sendServerNotification({
                method: "error",
                params: {threadId: "session-id", turnId: turn.id, willRetry: false, error: turn.error},
            })
        }
        turnCompleted.resolve({threadId: "session-id", turn})
        if (status === "failed") {
            await expect(steerPromise).rejects.toMatchObject({code: -32603, data: {message: "provider failure"}})
        } else {
            const stopReason = status === "interrupted" ? "cancelled" : "end_turn"
            await expect(steerPromise).resolves.toEqual({outcome: "startedNewTurn", stopReason})
        }
    });

    it('starts a new turn when Codex reports that the tracked turn is no longer active', async () => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn();
        const nextTurnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValueOnce({turn: createTurn("turn-id", "inProgress")})
            .mockResolvedValueOnce({turn: createTurn("new-turn-id", "inProgress")});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValueOnce(turnCompleted.promise)
            .mockReturnValueOnce(nextTurnCompleted.promise);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(async () => {
            turnCompleted.resolve({
                threadId: "session-id",
                turn: createTurn("turn-id", "completed"),
            });
            throw Object.assign(new Error("Internal error"), {
                data: {details: "no active turn to steer"},
            });
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "racing follow-up"}],
        })).resolves.toEqual({outcome: "startedNewTurn"});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(sessionState.currentTurnId).toBe("new-turn-id");

        nextTurnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBeNull();
        });
    });

    it.each([false, true])('serializes concurrent late steering requests with waitForCompletion=%s', async (waitForCompletion) => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "new-turn-id"});

        const firstRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "first late follow-up"}],
            waitForCompletion,
        });
        const secondRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "second late follow-up"}],
            waitForCompletion,
        });

        await vi.waitFor(() => {
            expect(turnSteerSpy).toHaveBeenCalled()
        })
        expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            expectedTurnId: "new-turn-id",
            input: [{type: "text", text: "second late follow-up", text_elements: []}],
        });

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        const completion = waitForCompletion ? {stopReason: "end_turn"} : {}
        await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
            {outcome: "startedNewTurn", ...completion},
            {outcome: "injected", ...completion},
        ])
    });

    it('reports failed instead of throwing when steering hits an unexpected error', async () => {
        const mockFixture = createCodexMockTestFixture();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockImplementation(() => {
            throw new Error("unexpected boom");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "keep the agent alive"}],
        })).resolves.toEqual({outcome: "failed"});
    });

    it('rejects malformed steer params', async () => {
        const mockFixture = createCodexMockTestFixture();

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
        })).rejects.toThrow(RequestError);
    });

    it('rejects image input when the model does not support it', async () => {
        const {mockFixture} = startActiveTurn({supportedInputModalities: ["text"]});
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer");

        const image: acp.ContentBlock = {
            type: "image",
            mimeType: "image/png",
            data: "abc123",
        };

        const error = await mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [image],
        }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).data).toContain("does not support image input");
        expect(turnSteerSpy).not.toHaveBeenCalled();
    });
});
