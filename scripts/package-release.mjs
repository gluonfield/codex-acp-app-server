import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import packageJson from "../package.json" with {type: "json"};

const [platform, triple, adapterPath, outputDir = "dist/release"] = process.argv.slice(2);
if (!platform || !triple || !adapterPath) {
    throw new Error("usage: package-release.mjs <platform> <triple> <adapter-path> [output-dir]");
}

const runtime = resolve(`node_modules/@openai/codex-${platform}/vendor/${triple}`);
const adapter = resolve(adapterPath);
const output = resolve(outputDir);
const staging = mkdtempSync(join(tmpdir(), "codex-acp-release-"));
const adapterName = platform.startsWith("win32-") ? "codex-acp.exe" : "codex-acp";
const archive = join(
    output,
    `codex-acp-app-server-${packageJson.version}-${platform}.tar.gz`,
);

try {
    mkdirSync(output, {recursive: true});
    cpSync(adapter, join(staging, adapterName));
    cpSync(runtime, join(staging, "codex-runtime", triple), {recursive: true});
    if (!platform.startsWith("win32-")) {
        chmodSync(join(staging, adapterName), 0o755);
    }
    execFileSync("tar", [
        "-czf",
        archive,
        "-C",
        staging,
        adapterName,
        "codex-runtime",
    ], {stdio: "inherit"});
    console.log(`${basename(archive)} contains Codex ${packageJson.dependencies["@openai/codex"]}`);
} finally {
    rmSync(staging, {recursive: true, force: true});
}
