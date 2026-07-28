import type {ServiceTier} from "./app-server";
import type {ModeKind} from "./app-server/ModeKind";
import type {Model, Thread} from "./app-server/v2";

export interface SessionMetadata {
    sessionId: string;
    currentModelId: string;
    models: Model[];
    collaborationMode: ModeKind;
    modelProvider?: string | null;
    currentServiceTier?: ServiceTier | null;
    additionalDirectories: string[];
}

export interface SessionMetadataWithThread extends SessionMetadata {
    thread: Thread;
}
