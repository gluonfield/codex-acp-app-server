import {describe, expect, it, vi} from "vitest";
import {RequestError} from "@agentclientprotocol/sdk";
import {type CodexMockTestFixture, createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("New session login failures", () => {
    it("asks for a new login and keeps the stored one when newSession fails with a refresh failure", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        exposeTestModel(fixture);
        const errorMessage = `Internal error: "failed to load configuration: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`;
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                code: RequestError.authRequired().code,
                message: `Authentication required: ${errorMessage}`,
            });
        expect(logoutSpy).not.toHaveBeenCalled();
    });

    it("includes the global config path in reload configuration errors", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        exposeTestModel(fixture);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const errorMessage = 'Internal error: "failed to reload config: filesystem path `/tmp` must be absolute, use `~/...`, or start with `:`"';
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        expect(logoutSpy).toHaveBeenCalledTimes(0);
        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining(`Check global and project .codex directories`),
            });
    });
});

function exposeTestModel(fixture: CodexMockTestFixture): void {
    vi.spyOn(fixture.getCodexAppServerClient(), "listModels").mockResolvedValue({
        data: [createTestModel()],
        nextCursor: null,
    });
}
