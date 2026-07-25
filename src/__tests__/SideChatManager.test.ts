import {describe, expect, it, vi} from "vitest";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {CodexAcpClient} from "../CodexAcpClient";
import {SideChatManager} from "../SideChatManager";
import {createTestSessionState} from "./acp-test-utils";

describe("SideChatManager", () => {
    it("uses one ephemeral fork for follow-up prompts and closes it with the parent", async () => {
        const codex = {
            forkSideSession: vi.fn().mockResolvedValue({
                sessionId: "side-thread",
                currentModelId: "model-id[effort]",
            }),
            subscribeToSessionEvents: vi.fn().mockResolvedValue(undefined),
            sendPrompt: vi.fn().mockResolvedValue({
                turn: {id: "turn", status: "completed"},
            }),
            waitForSessionNotifications: vi.fn().mockResolvedValue(undefined),
            closeSession: vi.fn().mockResolvedValue(undefined),
            turnInterrupt: vi.fn().mockResolvedValue(undefined),
        } as unknown as CodexAcpClient;
        const connection = {
            notify: vi.fn().mockResolvedValue(undefined),
            request: vi.fn(),
        } as unknown as AcpClientConnection;
        const manager = new SideChatManager(connection, codex, () => null, operation => operation());
        const parent = createTestSessionState({sessionId: "parent"});
        const scope = {id: "side-1", command: "btw", parentSessionId: "parent"};

        await manager.prompt({
            sessionId: "parent",
            prompt: [{type: "text", text: "what changed?"}],
            _meta: {codex: {sideChat: scope}},
        }, parent, scope);
        await manager.prompt({
            sessionId: "parent",
            prompt: [{type: "text", text: "and now?"}],
            _meta: {codex: {sideChat: scope}},
        }, parent, scope);

        expect(codex.forkSideSession).toHaveBeenCalledOnce();
        expect(codex.forkSideSession).toHaveBeenCalledWith(
            parent,
            expect.stringContaining("side conversation"),
        );
        const firstRequest = vi.mocked(codex.sendPrompt).mock.calls[0]![0];
        const secondRequest = vi.mocked(codex.sendPrompt).mock.calls[1]![0];
        expect(firstRequest.sessionId).toBe("side-thread");
        expect(firstRequest.prompt[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("Side conversation boundary."),
        });
        expect(secondRequest).toMatchObject({
            sessionId: "side-thread",
            prompt: [{type: "text", text: "and now?"}],
        });

        await manager.closeParent("parent");
        expect(codex.closeSession).toHaveBeenCalledWith("side-thread");
    });

    it("does not fork the same side chat twice while its fork is starting", async () => {
        let resolveFork!: (value: {sessionId: string; currentModelId: string}) => void;
        const fork = new Promise<{sessionId: string; currentModelId: string}>(resolve => {
            resolveFork = resolve;
        });
        const codex = {
            forkSideSession: vi.fn().mockReturnValue(fork),
            subscribeToSessionEvents: vi.fn().mockResolvedValue(undefined),
            sendPrompt: vi.fn().mockResolvedValue({
                turn: {id: "turn", status: "completed"},
            }),
            waitForSessionNotifications: vi.fn().mockResolvedValue(undefined),
            closeSession: vi.fn().mockResolvedValue(undefined),
            turnInterrupt: vi.fn().mockResolvedValue(undefined),
        } as unknown as CodexAcpClient;
        const manager = new SideChatManager(
            {notify: vi.fn(), request: vi.fn()} as unknown as AcpClientConnection,
            codex,
            () => null,
            operation => operation(),
        );
        const parent = createTestSessionState({sessionId: "parent"});
        const scope = {id: "side-1", command: "btw", parentSessionId: "parent"};
        const request = {
            sessionId: "parent",
            prompt: [{type: "text" as const, text: "what changed?"}],
        };

        const first = manager.prompt(request, parent, scope);
        const second = manager.prompt(request, parent, scope);
        const rejected = expect(second).rejects.toThrow("Side chat is already running");
        resolveFork({sessionId: "side-thread", currentModelId: "model-id[effort]"});

        await Promise.all([first, rejected]);
        expect(codex.forkSideSession).toHaveBeenCalledOnce();
    });

    it("closes a side fork that is still starting when its parent closes", async () => {
        let resolveFork!: (value: {sessionId: string; currentModelId: string}) => void;
        const fork = new Promise<{sessionId: string; currentModelId: string}>(resolve => {
            resolveFork = resolve;
        });
        const codex = {
            forkSideSession: vi.fn().mockReturnValue(fork),
            closeSession: vi.fn().mockResolvedValue(undefined),
        } as unknown as CodexAcpClient;
        const manager = new SideChatManager(
            {notify: vi.fn(), request: vi.fn()} as unknown as AcpClientConnection,
            codex,
            () => null,
            operation => operation(),
        );
        const parent = createTestSessionState({sessionId: "parent"});
        const scope = {id: "side-1", command: "btw", parentSessionId: "parent"};
        const prompting = manager.prompt({
            sessionId: "parent",
            prompt: [{type: "text", text: "what changed?"}],
        }, parent, scope);
        const closing = manager.closeParent("parent");

        resolveFork({sessionId: "side-thread", currentModelId: "model-id[effort]"});

        await expect(prompting).resolves.toMatchObject({stopReason: "cancelled"});
        await closing;
        expect(codex.closeSession).toHaveBeenCalledOnce();
    });
});
