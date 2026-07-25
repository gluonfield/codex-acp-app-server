import {describe, expect, it} from "vitest";
import {
    JAZ_MODEL_METADATA_ENV,
    mergeJazModelMetadata,
    readJazModelMetadata,
} from "../JazModelMetadata";
import {ModelId} from "../ModelId";
import {createTestModel} from "./acp-test-utils";

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

    it("replaces only the matching catalog model", () => {
        const keep = createTestModel({id: "keep"});
        const metadata = readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "custom",
                display_name: "Custom",
                context_window: 128_000,
                input_modalities: ["text"],
            }),
        } as NodeJS.ProcessEnv);

        const models = mergeJazModelMetadata([keep, createTestModel({id: "custom"})], metadata);

        expect(models).toHaveLength(2);
        expect(models[0]).toBe(keep);
        expect(models[1]).toMatchObject({
            id: "custom",
            displayName: "Custom",
            inputModalities: ["text"],
            supportedReasoningEfforts: [{
                reasoningEffort: "medium",
                description: "Balanced",
            }],
            defaultReasoningEffort: "medium",
        });
    });

    it("does not invent a model when provider capabilities are unknown", () => {
        const keep = createTestModel({id: "keep"});
        const metadata = readJazModelMetadata({
            [JAZ_MODEL_METADATA_ENV]: JSON.stringify({
                id: "custom",
                context_window: 128_000,
            }),
        } as NodeJS.ProcessEnv);

        expect(metadata).toMatchObject({
            displayName: null,
            description: null,
            inputModalities: null,
            reasoningEfforts: null,
        });
        expect(mergeJazModelMetadata([keep], metadata)).toEqual([keep]);
    });

    it("keeps missing reasoning effort unknown", () => {
        const modelId = ModelId.create("custom", null);
        expect(modelId.toString()).toBe("custom");
        expect(ModelId.fromString("custom")).toEqual(modelId);
    });
});
