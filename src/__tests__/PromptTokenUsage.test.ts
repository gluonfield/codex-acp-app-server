import {expect, it} from 'vitest';
import {PromptTokenUsage, toTokenCount} from '../TokenCount';
import nativeUsage from './CodexACPAgent/data/native-token-usage-20260910.json';

it('separates restored history, new turns, counter resets, and context estimates', () => {
    const tracker = new PromptTokenUsage();
    const first = toTokenCount(nativeUsage[0]!.last);
    tracker.record('historical', first, first);
    expect(tracker.usage).toBeNull();

    tracker.start('new');
    tracker.record('historical', first, first);
    expect(tracker.usage).toBeNull();
    tracker.record('new', first, first);
    expect(tracker.usage).toEqual(first);
    tracker.start('new');
    tracker.record('new', first, first);
    expect(tracker.usage).toEqual(first);

    const second = toTokenCount(nativeUsage[1]!.last);
    tracker.record('new', second, second);
    expect(tracker.usage?.totalTokens).toBe(first.totalTokens + second.totalTokens);
    const estimate = {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 20_000};
    tracker.record('new', estimate, estimate);
    tracker.record('new', second, second);
    expect(tracker.usage?.totalTokens).toBe(first.totalTokens + second.totalTokens);

    tracker.start('next');
    tracker.record('next', first, first);
    expect(tracker.usage?.totalTokens).toBe(2 * first.totalTokens + second.totalTokens);
    expect(new PromptTokenUsage().usage).toBeNull();
});
