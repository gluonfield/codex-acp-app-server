import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestEventHandler, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import { TurnTokenUsage, toPromptUsage, toTokenCount, type TokenCount } from '../../TokenCount';
import type { TokenUsageBreakdown } from '../../app-server/v2';
import type { SessionState } from '../../CodexAcpServer';
import nativeUsage from './data/native-token-usage-20260910.json';
import { ACPSessionConnection } from '../../ACPSessionConnection';
import { CodexSubagentEventRouter } from '../../subagents/CodexSubagentEventRouter';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    },
    turnId = 'turn-id',
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId,
            tokenUsage,
        },
    };
}

function turnStarted(threadId: string, turnId = 'turn-id'): ServerNotification {
    return {
        method: 'turn/started',
        params: {
            threadId,
            turn: { id: turnId, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null },
        },
    };
}

/** Model output that precedes the usage update of a model request. */
function reasoningStarted(threadId: string, id = 'reasoning-id'): ServerNotification {
    return {
        method: 'item/started',
        params: {
            threadId,
            turnId: 'turn-id',
            startedAtMs: 0,
            item: { type: 'reasoning', id, summary: [], content: [] },
        },
    };
}

function breakdown(totalTokens: number, inputTokens: number, cachedInputTokens: number, outputTokens: number): TokenUsageBreakdown {
    return {totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 0};
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                mockFixture.sendServerNotification({
                    method: "turn/started",
                    params: {threadId: sessionId, turn: {id: "turn-id", items: [], status: "inProgress", error: null}},
                });
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('counts every call in a native Codex 0.153.4 trace and ignores replayed notifications', async () => {
            const notifications = nativeUsage.flatMap(usage => {
                const event = createTokenUsageNotification(sessionId, usage);
                return [event, event];
            });
            const agent = setupPromptWithTokenUsage(notifications);
            const response = await agent.prompt({sessionId, prompt: [{type: 'text', text: 'test prompt'}]});
            expect(response.usage).toEqual({
                inputTokens: 59_754,
                cachedReadTokens: 519_424,
                cachedWriteTokens: 0,
                outputTokens: 3_711,
                thoughtTokens: 877,
                totalTokens: 582_889,
            });
            const updates = mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update);
            expect(updates[0]._meta.usage.totalTokens).toBe(41_223);
            expect(updates.at(-1)._meta.usage).toEqual(response.usage);
            expect(updates.at(-1).used).toBe(70_302);
        });

        it('does not replay the previous prompt usage when cancelled before a new turn starts', async () => {
            const agent = setupPromptWithTokenUsage([]);
            const state = agent.getSessionState(sessionId);
            const usage = toTokenCount(nativeUsage[0]!.last);
            state.promptTokenUsage.start('previous');
            state.promptTokenUsage.record('previous', usage, usage);
            const controller = new AbortController();
            controller.abort();
            const response = await agent.prompt({sessionId, prompt: [{type: 'text', text: 'test prompt'}]}, controller.signal);
            expect(response.stopReason).toBe('cancelled');
            expect(response.usage).toBeNull();
        });

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('counts every model call in the prompt response', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    describe('PromptResponse usage of the whole turn', () => {
        function setupPrompts(
            turns: ServerNotification[][],
            state: Partial<SessionState> = {},
        ) {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();
            let turn = 0;
            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockImplementation(async () => ({
                turn: { id: `turn-${turn + 1}`, items: [], status: "inProgress", error: null },
            }));
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                const notifications = turns[turn++] ?? [];
                for (const notification of [turnStarted(sessionId), reasoningStarted(sessionId), ...notifications]) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: `turn-${turn}`, items: [], status: "completed", error: null },
                };
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId, ...state }));
            return async () => await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });
        }

        it('sums every model request of the turn', async () => {
            const prompt = setupPrompts([[
                createTokenUsageNotification(sessionId, {
                    total: breakdown(1000, 800, 0, 200),
                    last: breakdown(1000, 800, 0, 200),
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: breakdown(2300, 1900, 700, 400),
                    last: breakdown(1300, 1100, 700, 200),
                    modelContextWindow: 128000,
                }),
            ]]);

            const response = await prompt();

            expect(response.usage).toEqual({
                totalTokens: 2300,
                inputTokens: 1200,
                cachedReadTokens: 700,
                cachedWriteTokens: 0,
                outputTokens: 400,
                thoughtTokens: 0,
            });
        });

        it('reports only the usage of the turn after an earlier turn', async () => {
            const prompt = setupPrompts([
                [
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(1000, 800, 0, 200),
                        last: breakdown(1000, 800, 0, 200),
                        modelContextWindow: 128000,
                    }),
                ],
                [
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(2500, 2000, 600, 500),
                        last: breakdown(1500, 1200, 600, 300),
                        modelContextWindow: 128000,
                    }),
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(4500, 3700, 1800, 800),
                        last: breakdown(2000, 1700, 1200, 300),
                        modelContextWindow: 128000,
                    }),
                ],
            ]);

            await prompt();
            const response = await prompt();

            expect(response.usage).toEqual({
                totalTokens: 3500,
                inputTokens: 1100,
                cachedReadTokens: 1800,
                cachedWriteTokens: 0,
                outputTokens: 600,
                thoughtTokens: 0,
            });
        });

        it('does not count the inherited history of a forked or resumed thread', async () => {
            // The first total of a forked or resumed thread already includes the usage of its history.
            const prompt = setupPrompts([[
                createTokenUsageNotification(sessionId, {
                    total: breakdown(102000, 100000, 80000, 2000),
                    last: breakdown(2000, 1800, 1500, 200),
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: breakdown(105000, 102700, 82000, 2300),
                    last: breakdown(3000, 2700, 2000, 300),
                    modelContextWindow: 128000,
                }),
            ]]);

            const response = await prompt();

            expect(response.usage?.totalTokens).toBe(5000);
            expect(response.usage?.inputTokens).toBe(1000);
            expect(response.usage?.cachedReadTokens).toBe(3500);
            expect(response.usage?.outputTokens).toBe(500);
        });

        it('does not count a re-sent update twice', async () => {
            const first = createTokenUsageNotification(sessionId, {
                total: breakdown(1000, 800, 0, 200),
                last: breakdown(1000, 800, 0, 200),
                modelContextWindow: 128000,
            });
            const second = createTokenUsageNotification(sessionId, {
                total: breakdown(2500, 2000, 0, 500),
                last: breakdown(1500, 1200, 0, 300),
                modelContextWindow: 128000,
            });
            const prompt = setupPrompts([[first, second, second]]);

            const response = await prompt();

            expect(response.usage?.totalTokens).toBe(2500);
        });

        it('does not report the usage of the previous prompt for a prompt without a turn', async () => {
            const prompt = setupPrompts([[
                createTokenUsageNotification(sessionId, {
                    total: breakdown(1000, 800, 0, 200),
                    last: breakdown(1000, 800, 0, 200),
                    modelContextWindow: 128000,
                }),
            ]]);
            await prompt();

            const response = await mockFixture.getCodexAcpAgent().prompt({
                sessionId,
                prompt: [{ type: 'text', text: '/status' }],
            });

            expect(response.usage).toBeNull();
        });

        describe('_meta.quota', () => {
            const quotaOf = (response: { _meta?: Record<string, unknown> | null }) =>
                (response._meta as { quota: { token_count: TokenCount | null, model_usage: Array<{ model: string, token_count: TokenCount }> } }).quota;

            it('reports the whole turn after an earlier turn, as PromptResponse.usage does', async () => {
                const prompt = setupPrompts([
                    [createTokenUsageNotification(sessionId, {
                        total: breakdown(1000, 800, 0, 200),
                        last: breakdown(1000, 800, 0, 200),
                        modelContextWindow: 128000,
                    })],
                    [
                        createTokenUsageNotification(sessionId, {
                            total: breakdown(2500, 2000, 600, 500),
                            last: breakdown(1500, 1200, 600, 300),
                            modelContextWindow: 128000,
                        }),
                        createTokenUsageNotification(sessionId, {
                            total: breakdown(4500, 3700, 1800, 800),
                            last: breakdown(2000, 1700, 1200, 300),
                            modelContextWindow: 128000,
                        }),
                    ],
                ]);

                await prompt();
                const response = await prompt();

                const quota = quotaOf(response);
                expect(quota.token_count).toMatchObject({totalTokens: 3500, inputTokens: 1100, cachedInputTokens: 1800, outputTokens: 600});
                expect(toPromptUsage(quota.token_count!)).toEqual(response.usage);
                expect(quota.model_usage).toEqual([{model: expect.any(String), token_count: quota.token_count}]);
            });

            it('leaves out the inherited history of a forked or resumed thread, as PromptResponse.usage does', async () => {
                const prompt = setupPrompts([[
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(102000, 100000, 80000, 2000),
                        last: breakdown(2000, 1800, 1500, 200),
                        modelContextWindow: 128000,
                    }),
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(105000, 102700, 82000, 2300),
                        last: breakdown(3000, 2700, 2000, 300),
                        modelContextWindow: 128000,
                    }),
                ]]);

                const response = await prompt();

                expect(quotaOf(response).token_count?.totalTokens).toBe(5000);
                expect(toPromptUsage(quotaOf(response).token_count!)).toEqual(response.usage);
            });

            it('reports no usage for a prompt without a turn', async () => {
                const prompt = setupPrompts([[
                    createTokenUsageNotification(sessionId, {
                        total: breakdown(1000, 800, 0, 200),
                        last: breakdown(1000, 800, 0, 200),
                        modelContextWindow: 128000,
                    }),
                ]]);
                await prompt();

                const response = await mockFixture.getCodexAcpAgent().prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: '/status' }],
                });

                expect(quotaOf(response)).toEqual({token_count: null, model_usage: []});
            });
        });

        it('never reports negative usage when the thread total goes back', async () => {
            const prompt = setupPrompts([[
                createTokenUsageNotification(sessionId, {
                    total: breakdown(1500, 1200, 0, 300),
                    last: breakdown(1500, 1200, 0, 300),
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: breakdown(2500, 2000, 0, 500),
                    last: breakdown(1000, 800, 0, 200),
                    modelContextWindow: 128000,
                }),
            ]], {
                totalTokenUsage: {
                    totalTokens: 9000,
                    inputTokens: 8000,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 1000,
                    reasoningOutputTokens: 0,
                },
            });

            const response = await prompt();

            // The total cannot be compared with the start, so the requests of the turn are summed.
            expect(response.usage?.totalTokens).toBe(2500);
            expect(response.usage?.inputTokens).toBe(2000);
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                mockFixture.sendServerNotification({
                    method: "turn/started",
                    params: {threadId: sessionId, turn: {id: "turn-id", items: [], status: "inProgress", error: null}},
                });
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should report usage while the context window remains unknown', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toHaveLength(1);
            expect(events[0]?.args[0].update).toEqual({
                sessionUpdate: "session_info_update",
                _meta: {usageId: "turn-id", usage: {inputTokens: 1500, cachedReadTokens: 500, cachedWriteTokens: 0, outputTokens: 450, thoughtTokens: 50, totalTokens: 2500}},
            });
        });
    });
    describe('usage of child threads', () => {
        const childThreadId = 'child-thread-id';
        const parentUsage = createTokenUsageNotification(sessionId, {
            total: breakdown(1000, 800, 0, 200),
            last: breakdown(1000, 800, 0, 200),
            modelContextWindow: 128000,
        });
        const childUsage = createTokenUsageNotification(childThreadId, {
            total: breakdown(50000, 49000, 40000, 1000),
            last: breakdown(50000, 49000, 40000, 1000),
            modelContextWindow: 200000,
        }, 'child-turn-id');
        const childSpawned: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-id',
                startedAtMs: 0,
                item: {
                    type: 'subAgentActivity',
                    id: 'activity-started',
                    kind: 'started',
                    agentThreadId: childThreadId,
                    agentPath: '/root/worker',
                },
            },
        };

        const childCompleted: ServerNotification = {
            method: 'turn/completed',
            params: {
                threadId: childThreadId,
                turn: {
                    id: 'child-turn-id',
                    items: [],
                    itemsView: 'notLoaded',
                    status: 'completed',
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        };

        it('keeps the usage of a native subagent out of the parent session', async () => {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();
            await codexAcpAgent.initialize({
                protocolVersion: 1,
                clientCapabilities: {
                    _meta: { jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions'] } } },
                },
            });
            const sessionState = createTestSessionState({ sessionId });
            sessionState.subagents = new CodexSubagentEventRouter(
                sessionId,
                true,
                new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
                () => {},
            );
            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: 'turn-id', items: [], status: 'inProgress', error: null },
            });
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of [turnStarted(sessionId), childSpawned, reasoningStarted(sessionId), parentUsage, childUsage, childCompleted]) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: 'turn-id', items: [], status: 'completed', error: null },
                };
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            const usageUpdates = mockFixture.getAcpConnectionEvents([])
                .filter(event => event.method === 'sessionUpdate' && event.args[0].update.sessionUpdate === 'usage_update')
                .map(event => ({ sessionId: event.args[0].sessionId, used: event.args[0].update.used, size: event.args[0].update.size }));
            expect(usageUpdates).toEqual([
                { sessionId, used: 1000, size: 128000 },
                { sessionId: childThreadId, used: 50000, size: 200000 },
            ]);
            expect(sessionState.lastTokenUsage?.totalTokens).toBe(1000);
            expect(sessionState.totalTokenUsage?.totalTokens).toBe(1000);
            expect(sessionState.modelContextWindow).toBe(128000);
            expect(response.usage?.totalTokens).toBe(1000);
        });

        it('ignores the usage of a thread that is not the session or its subagent', async () => {
            const sessionState = createTestSessionState({ sessionId });
            const handler = createTestEventHandler(mockFixture.getAcpConnection(), sessionState);
            sessionState.promptTokenUsage = new TurnTokenUsage();
            sessionState.promptTokenUsage.start('turn-id');

            await handler.handleNotification(parentUsage);
            await handler.handleNotification(childUsage);

            const usageUpdates = mockFixture.getAcpConnectionEvents([])
                .filter(event => event.method === 'sessionUpdate' && event.args[0].update.sessionUpdate === 'usage_update')
                .map(event => ({ sessionId: event.args[0].sessionId, used: event.args[0].update.used, size: event.args[0].update.size }));
            expect(usageUpdates).toEqual([{ sessionId, used: 1000, size: 128000 }]);
            expect(sessionState.lastTokenUsage?.totalTokens).toBe(1000);
            expect(sessionState.modelContextWindow).toBe(128000);
            expect(sessionState.promptTokenUsage.usage?.totalTokens).toBe(1000);
        });
    });
});

it('accounts for native child calls separately from the parent context and prompt', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const connection = {notify, request: vi.fn()};
    const state = createTestSessionState({sessionId: 'parent'});
    state.subagents = new CodexSubagentEventRouter('parent', false, new ACPSessionConnection(connection, 'parent'), () => {});
    const handler = createTestEventHandler(connection, state);
    const first = nativeUsage[0]!;
    await handler.handleNotification({
        method: 'turn/started',
        params: {threadId: 'child', turn: {id: 'turn-id', status: 'inProgress', items: [], error: null, itemsView: 'full', startedAt: null, completedAt: null, durationMs: null}},
    });
    const event = createTokenUsageNotification('child', first);
    await handler.handleNotification(event);
    await handler.handleNotification(event);
    expect(state.promptTokenUsage.usage).toBeNull();
    expect(state.lastTokenUsage).toBeNull();
    expect(notify.mock.calls[0]![1]).toMatchObject({
        sessionId: 'parent',
        update: {
            sessionUpdate: 'session_info_update',
            _meta: {usageId: 'turn-id', usage: {totalTokens: first.last.totalTokens}},
        },
    });
    expect(notify.mock.calls[1]![1]).toEqual(notify.mock.calls[0]![1]);
});
