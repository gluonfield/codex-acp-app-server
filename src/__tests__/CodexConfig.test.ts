import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {readCodexConfig} from "../CodexConfig";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, {recursive: true, force: true})));
function configPath() {
    const directory = mkdtempSync(join(tmpdir(), "codex-config-"));
    directories.push(directory);
    return join(directory, "config with spaces.json");
}

describe("Codex config transport", () => {
    it("preserves inline JSON and empty configuration", () => {
        expect(readCodexConfig(undefined)).toEqual({});
        expect(readCodexConfig("")).toEqual({});
        expect(readCodexConfig('{"features":{"goals":false}}')).toEqual({features: {goals: false}});
    });
    it("loads a large UTF-8 prompt without truncating or rewriting its JSON values", () => {
        const path = configPath();
        const config = {developer_instructions: "Привет 🌍\n\"quotes\" \\path\n".repeat(20000), features: {goals: false}, model_provider: "openai"};
        writeFileSync(path, JSON.stringify(config), {mode: 0o600});
        expect(readCodexConfig(`@${path}`)).toEqual(config);
    });
    it("fails closed for unreadable files and invalid JSON", () => {
        const path = configPath();
        expect(() => readCodexConfig(`@${path}`)).toThrow();
        writeFileSync(path, "{broken");
        expect(() => readCodexConfig(`@${path}`)).toThrow();
        expect(() => readCodexConfig("{broken")).toThrow();
    });
});
