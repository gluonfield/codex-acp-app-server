import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it, vi} from "vitest";
import type {AcpClientConnection} from "../ACPSessionConnection";
import {scopedAcpConnection} from "../ScopedAcpConnection";

describe("scoped ACP connection", () => {
    it("routes side updates to the parent and preserves Codex metadata", async () => {
        const notify = vi.fn().mockResolvedValue(undefined);
        const request = vi.fn().mockResolvedValue({outcome: {outcome: "cancelled"}});
        const scoped = scopedAcpConnection(
            {notify, request} as AcpClientConnection,
            "parent",
            {codex: {sideChat: {id: "side-1", threadId: "fork"}}},
        );

        await scoped.notify(acp.methods.client.session.update, {
            sessionId: "fork",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool",
                title: "Work",
                status: "in_progress",
                _meta: {codex: {collaboration: {tool: "spawn"}}},
            },
        });

        expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
            sessionId: "parent",
            update: expect.objectContaining({
                _meta: {
                    codex: {
                        collaboration: {tool: "spawn"},
                        sideChat: {id: "side-1", threadId: "fork"},
                    },
                },
            }),
        });
    });

    it("routes side permission requests to the parent session", async () => {
        const request = vi.fn().mockResolvedValue({outcome: {outcome: "cancelled"}});
        const scoped = scopedAcpConnection(
            {notify: vi.fn(), request} as AcpClientConnection,
            "parent",
            {},
        );

        await scoped.request(acp.methods.client.session.requestPermission, {
            sessionId: "fork",
            toolCall: {
                toolCallId: "tool",
                title: "Work",
                status: "pending",
            },
            options: [],
        });

        expect(request).toHaveBeenCalledWith(
            acp.methods.client.session.requestPermission,
            expect.objectContaining({sessionId: "parent"}),
            undefined,
        );
    });
});
