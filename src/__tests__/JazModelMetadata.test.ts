import {describe, expect, it} from "vitest";
import {
    JAZ_MODEL_METADATA_ENV,
    modelFromJazMetadata,
    readJazModelMetadata,
    resolveJazModelMetadata,
} from "../JazModelMetadata";
import {ModelId} from "../ModelId";

describe("Jaz model metadata", () => {
    it("parses exact custom-provider capabilities", () => {
        const metadata = readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "moonshotai/kimi-k3",
                display_name: "Kimi K3",
                description: "Agentic reasoning model",
                context_window: 1_048_576,
                input_modalities: ["text", "image"],
                reasoning_efforts: ["low", "high", "max"],
                default_reasoning_effort: "max",
            }),
        } as NodeJS.ProcessEnv);

        expect(metadata).toEqual({
            id: "moonshotai/kimi-k3",
            displayName: "Kimi K3",
            description: "Agentic reasoning model",
            contextWindow: 1_048_576,
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "max",
        });
    });

    it("rejects inconsistent reasoning metadata", () => {
        expect(() => readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "model",
                context_window: 128_000,
                reasoning_efforts: ["low"],
                default_reasoning_effort: "high",
            }),
        } as NodeJS.ProcessEnv)).toThrow("default_reasoning_effort must be one of reasoning_efforts");
    });

    it("allows known reasoning efforts without a declared default", () => {
        const metadata = readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "model",
                context_window: 128_000,
                input_modalities: ["text"],
                reasoning_efforts: ["low", "high"],
            }),
        } as NodeJS.ProcessEnv);

        expect(metadata?.defaultReasoningEffort).toBeNull();
        expect(resolveJazModelMetadata("custom", "model", metadata)?.defaultReasoningEffort).toBeNull();
    });

    it("requires exact metadata for custom providers", () => {
        expect(() => resolveJazModelMetadata("custom", "model", null))
            .toThrow("requires exact metadata");
        expect(() => resolveJazModelMetadata("custom", "other", {
            id: "model",
            displayName: null,
            description: null,
            contextWindow: 128_000,
            inputModalities: ["text"],
            reasoningEfforts: [],
            defaultReasoningEffort: null,
        })).toThrow("requires exact metadata");
        expect(resolveJazModelMetadata("openai-api-key", undefined, null)).toBeNull();
        expect(() => resolveJazModelMetadata(" openai ", "gpt-5", null))
            .toThrow("custom model_provider must be a non-empty normalized string");
        expect(() => resolveJazModelMetadata("openai", "gpt-5", {
            id: "gpt-5",
            displayName: null,
            description: null,
            contextWindow: 128_000,
            inputModalities: ["text"],
            reasoningEfforts: [],
            defaultReasoningEffort: null,
        })).toThrow("native model providers own their model metadata");
    });

    it("preserves known empty reasoning efforts", () => {
        const metadata = resolveJazModelMetadata("custom", "automatic", readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "automatic",
                context_window: 128_000,
                input_modalities: ["text"],
                reasoning_efforts: [],
            }),
        } as NodeJS.ProcessEnv));

        if (metadata === null) throw new Error("expected exact model metadata");
        expect(metadata.reasoningEfforts).toEqual([]);
        expect(modelFromJazMetadata(metadata)).toMatchObject({
            id: "automatic",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "",
        });
    });

    it("keeps missing reasoning effort unknown", () => {
        const modelId = ModelId.create("custom", null);
        expect(modelId.toString()).toBe("custom");
        expect(ModelId.fromString("custom")).toEqual(modelId);
    });
});
