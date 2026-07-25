import * as acp from "@agentclientprotocol/sdk";
import type {AcpClientConnection, UpdateSessionEvent} from "./ACPSessionConnection";

export function scopedAcpConnection(
    connection: AcpClientConnection,
    sessionId: string,
    updateMeta: Record<string, unknown>,
): AcpClientConnection {
    const notify = async <Params = unknown>(method: string, params?: Params): Promise<void> => {
        if (method === acp.methods.client.session.update && isRecord(params)) {
            const update = params["update"];
            return await connection.notify(
                acp.methods.client.session.update,
                {
                    ...params,
                    sessionId,
                    update: isRecord(update)
                        ? mergeUpdateMeta(update as UpdateSessionEvent, updateMeta)
                        : update,
                },
            );
        }
        return await connection.notify(method, scopeSessionId(params, sessionId));
    };

    const request = async <Response = unknown, Params = unknown>(
        method: string,
        params?: Params,
        options?: acp.SendRequestOptions,
    ): Promise<Response> => {
        return await connection.request<Response, unknown>(
            method,
            scopeSessionId(params, sessionId),
            options,
        );
    };

    return {notify, request};
}

function scopeSessionId(params: unknown, sessionId: string): unknown {
    if (!isRecord(params) || !("sessionId" in params)) return params;
    return {...params, sessionId};
}

function mergeUpdateMeta(
    update: UpdateSessionEvent,
    scopeMeta: Record<string, unknown>,
): UpdateSessionEvent {
    const currentMeta = isRecord(update._meta) ? update._meta : {};
    const currentCodex = isRecord(currentMeta["codex"]) ? currentMeta["codex"] : {};
    const scopeCodex = isRecord(scopeMeta["codex"]) ? scopeMeta["codex"] : {};
    return {
        ...update,
        _meta: {
            ...currentMeta,
            ...scopeMeta,
            codex: {
                ...currentCodex,
                ...scopeCodex,
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
