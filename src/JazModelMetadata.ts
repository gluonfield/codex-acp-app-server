import type {InputModality, ReasoningEffort} from "./app-server";
import type {Model} from "./app-server/v2";

export const JAZ_MODEL_METADATA_ENV = "JAZ_CODEX_MODEL_METADATA";

export interface JazModelMetadata {
    id: string;
    displayName: string | null;
    description: string | null;
    contextWindow: number;
    inputModalities: InputModality[] | null;
    reasoningEfforts: ReasoningEffort[] | null;
    defaultReasoningEffort: ReasoningEffort | null;
}

export interface ExactJazModelMetadata extends JazModelMetadata {
    inputModalities: InputModality[];
    reasoningEfforts: ReasoningEffort[];
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
    const displayName = optionalString(value, "display_name");
    const description = optionalString(value, "description");
    const contextWindow = value["context_window"];
    if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
        throw invalidMetadata("context_window must be a positive integer");
    }
    const inputModalities = optionalInputModalities(value);
    const reasoningEfforts = optionalStringArray(value, "reasoning_efforts");
    const defaultReasoningEffort = optionalString(value, "default_reasoning_effort");
    if (reasoningEfforts !== null && reasoningEfforts.length > 0
        && defaultReasoningEffort !== null
        && !reasoningEfforts.includes(defaultReasoningEffort)) {
        throw invalidMetadata("default_reasoning_effort must be one of reasoning_efforts");
    }
    if ((reasoningEfforts === null || reasoningEfforts.length === 0) && defaultReasoningEffort !== null) {
        throw invalidMetadata("default_reasoning_effort requires reasoning_efforts");
    }

    return {
        id,
        displayName,
        description,
        contextWindow,
        inputModalities,
        reasoningEfforts,
        defaultReasoningEffort,
    };
}

function usesCodexNativeModelCatalog(modelProvider: unknown): boolean {
    return modelProvider === undefined
        || modelProvider === null
        || modelProvider === ""
        || modelProvider === "openai"
        || modelProvider === "openai-api-key";
}

export function resolveJazModelMetadata(
    modelProvider: unknown,
    model: unknown,
    metadata: JazModelMetadata | null,
): ExactJazModelMetadata | null {
    if (usesCodexNativeModelCatalog(modelProvider)) {
        if (metadata !== null) {
            throw invalidMetadata("native model providers own their model metadata");
        }
        return null;
    }
    if (typeof modelProvider !== "string" || modelProvider.trim() !== modelProvider) {
        throw invalidMetadata("custom model_provider must be a non-empty normalized string");
    }
    if (typeof model !== "string" || model.trim() !== model || model.length === 0) {
        throw invalidMetadata(`model_provider ${JSON.stringify(modelProvider)} requires an explicit model`);
    }
    if (!hasExactCapabilities(metadata) || metadata.id !== model) {
        throw invalidMetadata(`model_provider ${JSON.stringify(modelProvider)} requires exact metadata for model ${JSON.stringify(model)}`);
    }
    return metadata;
}

export function modelFromJazMetadata(metadata: ExactJazModelMetadata): Model {
    return {
        id: metadata.id,
        model: metadata.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: metadata.displayName ?? metadata.id,
        description: metadata.description ?? "",
        hidden: false,
        supportedReasoningEfforts: toReasoningEfforts(metadata.reasoningEfforts),
        defaultReasoningEffort: metadata.defaultReasoningEffort ?? "",
        inputModalities: metadata.inputModalities,
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: false,
    };
}

function toReasoningEfforts(reasoningEfforts: ReasoningEffort[]) {
    return reasoningEfforts.map(reasoningEffort => ({
        reasoningEffort,
        description: `${reasoningEffort} reasoning effort`,
    }));
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

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | null {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (!Array.isArray(field)) {
        throw invalidMetadata(`${key} must be an array of non-empty strings`);
    }
    const values: string[] = [];
    for (const item of field) {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw invalidMetadata(`${key} must be an array of non-empty strings`);
        }
        values.push(item.trim());
    }
    return [...new Set(values)];
}

function optionalInputModalities(value: Record<string, unknown>): InputModality[] | null {
    const values = optionalStringArray(value, "input_modalities");
    return values?.map(modality => {
        if (modality === "text" || modality === "image" || modality === "audio") return modality;
        throw invalidMetadata(`unsupported input modality ${JSON.stringify(modality)}`);
    }) ?? null;
}

function hasExactCapabilities(metadata: JazModelMetadata | null): metadata is ExactJazModelMetadata {
    return metadata !== null
        && metadata.inputModalities !== null
        && metadata.inputModalities.length > 0
        && metadata.reasoningEfforts !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidMetadata(reason: unknown): Error {
    const detail = reason instanceof Error ? reason.message : String(reason);
    return new Error(`Invalid ${JAZ_MODEL_METADATA_ENV}: ${detail}`);
}
