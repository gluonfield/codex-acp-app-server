import {readFileSync} from "node:fs";
import type {JsonObject} from "./JsonObject";

export function readCodexConfig(value: string | undefined): JsonObject {
    if (!value) return {};
    const json = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
    return JSON.parse(json);
}
