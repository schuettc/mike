import type { Db } from "../../lib/supabase";
import {
    bedrockCredentials,
    bedrockServiceUrl,
    envBedrockCredentials,
} from "../../lib/llm/cloudProviders";
import { getEffectiveApiKeys } from "../user/user.service";
import { catalogFailureReason } from "./models.compatible";
import type { CatalogModel, CatalogResult } from "./models.service";

function modelId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/.test(value);
}

/** Regional foundation models and account-visible inference profiles. No keys leave the backend. */
export async function listBedrockModels(
    db: Db,
    userId: string,
    orgId?: string | null,
): Promise<CatalogResult> {
    // Reading the user's keys is Mike's own work: a failure there is an
    // internal error to log, not a provider outage.
    let credentials: ReturnType<typeof bedrockCredentials>;
    try {
        credentials = bedrockCredentials(
            await getEffectiveApiKeys(userId, orgId, db),
        );
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    if (!credentials) return {
        ok: false, kind: "missing_api_key", code: "missing_api_key",
        detail: "An Amazon Bedrock API key and AWS region (or BEDROCK_AUTH=iam on the server) are required to list models.",
    };
    const { region } = credentials;
    try {
        // Operator application profiles contain private account identifiers.
        // IAM mode only ever runs on the deployment's own AWS account.
        const env = envBedrockCredentials();
        const operatorAccount = credentials.auth === "iam" ||
            (env?.auth === "apiKey" && env.apiKey === credentials.apiKey);
        const base = bedrockServiceUrl("bedrock", region);
        const signal = AbortSignal.timeout(15_000);
        let read: (path: "foundation" | "profiles", nextToken?: string) => Promise<Record<string, unknown>>;
        if (credentials.auth === "iam") {
            const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import("@aws-sdk/client-bedrock");
            // Explicit endpoint, as for API keys: never AWS_ENDPOINT_URL* from the environment.
            const client = new BedrockClient({ region, endpoint: base });
            read = async (path, nextToken) => {
                const payload: unknown = path === "foundation"
                    ? await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), { abortSignal: signal })
                    : await client.send(new ListInferenceProfilesCommand({ maxResults: 1000, ...(nextToken ? { nextToken } : {}) }), { abortSignal: signal });
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Bedrock catalog response");
                return payload as Record<string, unknown>;
            };
        } else {
            const { apiKey } = credentials;
            read = async (path, nextToken) => {
                const url = path === "foundation"
                    ? `${base}/foundation-models?byOutputModality=TEXT`
                    : `${base}/inference-profiles?maxResults=1000${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ""}`;
                const response = await fetch(url, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    redirect: "error", signal,
                });
                // Do not retain provider response bodies: they may contain account or credential details.
                if (!response.ok) throw new Error(`Bedrock model catalog request failed (${response.status})`);
                const payload: unknown = await response.json();
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Bedrock catalog response");
                return payload as Record<string, unknown>;
            };
        }
        const models = new Map<string, CatalogModel>();
        const foundation = await read("foundation");
        if (!Array.isArray(foundation.modelSummaries)) throw new Error("Invalid Bedrock foundation model list");
        const textArns = new Set<string>();
        for (const model of foundation.modelSummaries) {
            if (!model || !modelId(model.modelId) || !model.outputModalities?.includes("TEXT") || model.modelLifecycle?.status === "LEGACY") continue;
            if (typeof model.modelArn === "string") textArns.add(model.modelArn);
            if (!model.inferenceTypesSupported?.includes("ON_DEMAND")) continue;
            models.set(model.modelId, { id: model.modelId, label: typeof model.modelName === "string" ? model.modelName : model.modelId });
        }
        let token: string | undefined;
        const seen = new Set<string>();
        do {
            const profiles = await read("profiles", token);
            if (!Array.isArray(profiles.inferenceProfileSummaries)) throw new Error("Invalid Bedrock inference profile list");
            for (const profile of profiles.inferenceProfileSummaries) {
                if (!profile || !modelId(profile.inferenceProfileId) || profile.status !== "ACTIVE") continue;
                if (operatorAccount && (profile.type !== "SYSTEM_DEFINED" || profile.inferenceProfileId.startsWith("arn:"))) continue;
                // Foundation ARNs in cross-region profiles differ only in their region.
                const isText = Array.isArray(profile.models) && profile.models.some((entry: { modelArn?: unknown }) =>
                    typeof entry?.modelArn === "string" && [...textArns].some(arn => arn.split(":foundation-model/")[1] === (entry.modelArn as string).split(":foundation-model/")[1]));
                if (!isText) continue;
                models.set(profile.inferenceProfileId, { id: profile.inferenceProfileId, label: typeof profile.inferenceProfileName === "string" ? profile.inferenceProfileName : profile.inferenceProfileId });
            }
            token = typeof profiles.nextToken === "string" && profiles.nextToken ? profiles.nextToken : undefined;
            if (token && (seen.has(token) || seen.size >= 100)) throw new Error("Invalid Bedrock catalog pagination");
            if (token) seen.add(token);
        } while (token);
        return { ok: true, models: [...models.values()].sort((a, b) => a.label.localeCompare(b.label)) };
    } catch (error) {
        return { ok: false, kind: "upstream", error: new Error(`Amazon Bedrock model catalog could not be loaded: ${catalogFailureReason(error)}`) };
    }
}
