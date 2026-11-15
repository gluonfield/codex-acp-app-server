import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {promisify} from "node:util";
import {expect, it} from "vitest";

const run = promisify(execFile);

it("forwards native CLI version flags without treating them as adapter flags", async () => {
    const bundled = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
    const native = await run(process.execPath, [bundled, "--version"]);
    const adapter = await run(process.execPath, ["--import", "tsx", "src/index.ts", "cli", "--version"], {
        env: {...process.env, CODEX_PATH: "", CODEX_API_KEY: "", OPENAI_API_KEY: ""},
    });
    expect(adapter.stdout).toBe(native.stdout);
    expect(adapter.stderr).toBe(native.stderr);
}, 20_000);
