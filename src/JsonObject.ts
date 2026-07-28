import type {JsonValue} from "./app-server/serde_json/JsonValue";

export type JsonObject = { [key in string]?: JsonValue };
