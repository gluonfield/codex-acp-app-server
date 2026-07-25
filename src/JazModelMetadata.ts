import type {InputModality, ReasoningEffort} from "./app-server";
import type {Model} from "./app-server/v2";

export const JAZ_MODEL_METADATA_ENV = "JAZ_CODEX_MODEL_METADATA";

export interface JazModelMetadata {
    id: string;
    displayName: string;
    description: string;
    contextWindow: number;
    inputModalities: InputModality[];
    reasoningEfforts: ReasoningEffort[];
    defaultReasoningEffort: ReasoningEffort | null;
}

export function readJazModelMetadata(env: NodeJS.ProcessEnv = process.env): JazModelMetadata | null {
    const raw = env[JAZ_MODEL_METADATA_ENV];
    if (!raw) return null;

    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw invalidMetadata(error);
    }
    if (!isRecord(value)) throw invalidMetadata("expected an object");

    const id = requiredString(value, "id");
    const displayName = optionalString(value, "display_name") ?? id;
    const description = optionalString(value, "description") ?? "";
    const contextWindow = value["context_window"];
    if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0) {
        throw invalidMetadata("context_window must be a positive integer");
    }
    const inputModalities = stringArray(value, "input_modalities");
    for (const modality of inputModalities) {
        if (modality !== "text" && modality !== "image" && modality !== "audio") {
            throw invalidMetadata(`unsupported input modality ${JSON.stringify(modality)}`);
        }
    }
    const reasoningEfforts = stringArray(value, "reasoning_efforts");
    const defaultReasoningEffort = optionalString(value, "default_reasoning_effort");
    if (reasoningEfforts.length > 0
        && (defaultReasoningEffort === null || !reasoningEfforts.includes(defaultReasoningEffort))) {
        throw invalidMetadata("default_reasoning_effort must be one of reasoning_efforts");
    }
    if (reasoningEfforts.length === 0 && defaultReasoningEffort !== null) {
        throw invalidMetadata("default_reasoning_effort requires reasoning_efforts");
    }

    return {
        id,
        displayName,
        description,
        contextWindow: contextWindow as number,
        inputModalities: inputModalities as InputModality[],
        reasoningEfforts,
        defaultReasoningEffort,
    };
}

export function mergeJazModelMetadata(models: Model[], metadata: JazModelMetadata | null): Model[] {
    if (metadata === null) return models;
    const model: Model = {
        id: metadata.id,
        model: metadata.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: metadata.displayName,
        description: metadata.description,
        hidden: false,
        supportedReasoningEfforts: metadata.reasoningEfforts.map(reasoningEffort => ({
            reasoningEffort,
            description: `${reasoningEffort} reasoning effort`,
        })),
        defaultReasoningEffort: metadata.defaultReasoningEffort ?? "",
        inputModalities: metadata.inputModalities,
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: false,
    };
    return [...models.filter(candidate => candidate.id !== metadata.id), model];
}

function requiredString(value: Record<string, unknown>, key: string): string {
    const result = optionalString(value, key);
    if (result === null) throw invalidMetadata(`${key} must be a non-empty string`);
    return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string") throw invalidMetadata(`${key} must be a string`);
    const result = field.trim();
    return result.length > 0 ? result : null;
}

function stringArray(value: Record<string, unknown>, key: string): string[] {
    const field = value[key];
    if (field === undefined || field === null) return [];
    if (!Array.isArray(field) || field.some(item => typeof item !== "string" || item.trim().length === 0)) {
        throw invalidMetadata(`${key} must be an array of non-empty strings`);
    }
    return [...new Set(field.map(item => (item as string).trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidMetadata(reason: unknown): Error {
    const detail = reason instanceof Error ? reason.message : String(reason);
    return new Error(`Invalid ${JAZ_MODEL_METADATA_ENV}: ${detail}`);
}
