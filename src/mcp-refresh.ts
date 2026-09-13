import { RequestError } from "@agentclientprotocol/sdk";

export const MCP_REFRESH_METHOD = "_session/mcp/refresh";

export type McpRefreshRequest = {
  sessionId: string;
  serverNames: string[];
};

export function parseMcpRefreshRequest(value: unknown): McpRefreshRequest {
  const params = value as Partial<McpRefreshRequest> | null;
  if (!params || typeof params.sessionId !== "string" || !params.sessionId.trim() ||
      !Array.isArray(params.serverNames) || params.serverNames.length === 0 ||
      !params.serverNames.every((name) => typeof name === "string" && name.trim())) {
    throw RequestError.invalidParams(undefined, "MCP refresh requires sessionId and serverNames");
  }
  return { sessionId: params.sessionId, serverNames: [...new Set(params.serverNames)] };
}
