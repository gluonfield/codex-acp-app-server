import {expect, it, vi} from 'vitest';
import {ACPSessionConnection} from '../ACPSessionConnection';
import {CodexSubagentEventRouter} from '../subagents/CodexSubagentEventRouter';
import type {Turn} from '../app-server/v2';
import nativeUsage from './CodexACPAgent/data/native-token-usage-20260910.json';

it.each(['materialize', 'complete', 'cancel'])('preserves child usage through buffered output and %s', async ending => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const router = new CodexSubagentEventRouter('parent', true, new ACPSessionConnection({notify, request: vi.fn()}, 'parent'));
    const turn: Turn = {
        id: 'child-turn', items: [], itemsView: 'full', status: 'inProgress', error: null,
        startedAt: null, completedAt: null, durationMs: null,
    };
    await router.handle({
        method: 'item/started',
        params: {
            threadId: 'parent', turnId: 'parent-turn', startedAtMs: 0,
            item: {
                type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'inProgress',
                senderThreadId: 'parent', receiverThreadIds: ['child'], prompt: 'Investigate usage',
                model: null, reasoningEffort: null, agentsStates: {child: {status: 'running', message: null}},
            },
        },
    });
    await router.handle({method: 'turn/started', params: {threadId: 'child', turn}});
    for (const tokenUsage of nativeUsage.slice(0, 2)) {
        await router.handle({
            method: 'thread/tokenUsage/updated',
            params: {threadId: 'child', turnId: turn.id, tokenUsage},
        });
        for (let i = 0; i < 1000; i++) {
            await router.handle({
                method: 'item/agentMessage/delta',
                params: {threadId: 'child', turnId: turn.id, itemId: 'message', delta: 'text'},
            });
        }
    }
    if (ending === 'materialize') {
        await router.handle({
            method: 'item/started',
            params: {
                threadId: 'parent', turnId: 'parent-turn', startedAtMs: 0,
                item: {type: 'subAgentActivity', id: 'activity', kind: 'started', agentThreadId: 'child', agentPath: '/root/usage'},
            },
        });
    } else if (ending === 'complete') {
        await router.handle({method: 'turn/completed', params: {threadId: 'child', turn: {...turn, status: 'completed'}}});
    } else {
        await router.finishOutstanding('cancelled');
    }
    const updates = notify.mock.calls.map(call => call[1]);
    const usage = updates.filter(update => update.update._meta?.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0].update._meta.usage.totalTokens).toBe(nativeUsage[1]!.total.totalTokens);
    expect(usage[0].update._meta.usageId).toBe('child-turn');
    expect(usage[0].sessionId).toBe(ending === 'materialize' ? 'child' : 'parent');
    if (ending !== 'materialize') {
        expect(usage[0].update.sessionUpdate).toBe('session_info_update');
        expect(usage[0].update.used).toBeUndefined();
        await router.handle({
            method: 'thread/tokenUsage/updated',
            params: {threadId: 'child', turnId: turn.id, tokenUsage: nativeUsage[1]!},
        });
        const late = notify.mock.calls.at(-1)![1];
        expect(late.sessionId).toBe('parent');
        expect(late.update._meta.usageId).toBe('child-turn');
        expect(late.update.used).toBeUndefined();
        expect(late.update.size).toBeUndefined();
    }
});
