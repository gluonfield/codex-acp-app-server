import type {
    CollabAgentStatus,
    CollabAgentTool,
    CollabAgentToolCallStatus,
    ThreadItem,
} from "./app-server/v2";

type CollaborationItem = Extract<ThreadItem, {type: "collabAgentToolCall"}>;
type ActivityItem = Extract<ThreadItem, {type: "subAgentActivity"}>;
type ProviderStatus = CollabAgentStatus | CollabAgentToolCallStatus;
type ProviderSubagentStatus = "starting" | "running" | "cancelled" | "completed" | "failed" | "stopped";

export interface ProviderSubagent {
    provider: "codex";
    id: string;
    thread_id: string;
    parent_id?: string;
    name?: string;
    task?: string;
    status: ProviderSubagentStatus;
    summary: string;
    prompt?: string;
    model?: string;
    reasoning_effort?: string;
}

export function collaborationSubagents(item: CollaborationItem): ProviderSubagent[] {
    return item.receiverThreadIds.filter(Boolean).map(id => {
        const state = item.agentsStates[id];
        const status = providerStatus(state?.status ?? item.status);
        const message = state?.message?.trim();
        return {
            provider: "codex",
            id,
            thread_id: id,
            parent_id: item.senderThreadId,
            status,
            summary: message || collaborationSummary(item.tool, status),
            ...(item.prompt === null ? {} : {prompt: item.prompt}),
            ...(item.model === null ? {} : {model: item.model}),
            ...(item.reasoningEffort === null ? {} : {reasoning_effort: item.reasoningEffort}),
        };
    });
}

export function activitySubagent(item: ActivityItem): ProviderSubagent {
    const name = item.agentPath.split("/").filter(Boolean).at(-1) ?? "";
    const [status, summary] = activityState(item.kind);
    return {
        provider: "codex",
        id: item.agentThreadId,
        thread_id: item.agentThreadId,
        ...(name ? {name, task: name} : {}),
        status,
        summary,
    };
}

function activityState(kind: ActivityItem["kind"]): [ProviderSubagentStatus, string] {
    switch (kind) {
        case "started":
            return ["running", "Spawned"];
        case "interacted":
            return ["running", "Working"];
        case "interrupted":
            return ["cancelled", "Interrupted"];
    }
}

function providerStatus(status: ProviderStatus): ProviderSubagentStatus {
    switch (status) {
        case "pendingInit":
            return "starting";
        case "inProgress":
            return "running";
        case "interrupted":
            return "cancelled";
        case "errored":
        case "notFound":
            return "failed";
        case "shutdown":
            return "stopped";
        default:
            return status;
    }
}

function collaborationSummary(tool: CollabAgentTool, status: ProviderSubagentStatus): string {
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Interrupted";

    const active = status === "running" || status === "starting";
    switch (tool) {
        case "spawnAgent":
            return "Spawned";
        case "sendInput":
            return active ? "Working" : "Responded";
        case "resumeAgent":
            return active ? "Resuming" : "Resumed";
        case "wait":
            return active ? "Waiting" : "Wait finished";
        case "closeAgent":
            return active ? "Closing" : "Closed";
    }
}
