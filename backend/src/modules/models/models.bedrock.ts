import { BedrockClient } from "@aws-sdk/client-bedrock";
import type { Db } from "../../lib/supabase";
import {
    bedrockCredentials,
    bedrockIamCredentials,
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
        detail: "An Amazon Bedrock API key and AWS region are required to list models.",
    };
    const { apiKey, region } = credentials;
    try {
        // Operator application profiles contain private account identifiers.
        const env = envBedrockCredentials();
        const operatorAccount = !!env && env.apiKey === apiKey;
        const base = bedrockServiceUrl("bedrock", region);
        const signal = AbortSignal.timeout(15_000);
        const read = async (path: string): Promise<Record<string, unknown>> => {
            const response = await fetch(`${base}${path}`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                redirect: "error", signal,
            });
            // Do not retain provider response bodies: they may contain account or credential details.
            if (!response.ok) throw new Error(`Bedrock model catalog request failed (${response.status})`);
            const payload: unknown = await response.json();
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Bedrock catalog response");
            return payload as Record<string, unknown>;
        };
        const models = new Map<string, CatalogModel>();
        const foundation = await read("/foundation-models?byOutputModality=TEXT");
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
            const profiles = await read(`/inference-profiles?maxResults=1000${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`);
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

/**
 * The Amazon Bedrock (IAM) catalog client. Explicit endpoint, as for API
 * keys: never AWS_ENDPOINT_URL* from the environment. SigV4 only: the SDK
 * otherwise switches to bearer auth whenever AWS_BEARER_TOKEN_BEDROCK is set.
 */
export function bedrockCatalogClient(region: string, endpoint: string): BedrockClient {
    return new BedrockClient({ region, endpoint, authSchemePreference: ["sigv4"] });
}

/**
 * Amazon Bedrock (IAM): the same catalog as listBedrockModels, listed with the
 * deployment's AWS role. It never reads a user's or organization's key, so
 * the user and organization do not change what it lists.
 */
export async function listBedrockIamModels(): Promise<CatalogResult> {
    const credentials = bedrockIamCredentials();
    if (!credentials) return {
        ok: false, kind: "missing_api_key", code: "missing_api_key",
        detail: "Amazon Bedrock (IAM) is not configured on this server.",
    };
    const { region } = credentials;
    try {
        const { ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import("@aws-sdk/client-bedrock");
        const client = bedrockCatalogClient(region, bedrockServiceUrl("bedrock", region));
        const signal = AbortSignal.timeout(15_000);
        const page = (payload: unknown): Record<string, unknown> => {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Bedrock catalog response");
            return payload as Record<string, unknown>;
        };
        const models = new Map<string, CatalogModel>();
        const foundation = page(await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), { abortSignal: signal }));
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
            const profiles = page(await client.send(new ListInferenceProfilesCommand({ maxResults: 1000, ...(token ? { nextToken: token } : {}) }), { abortSignal: signal }));
            if (!Array.isArray(profiles.inferenceProfileSummaries)) throw new Error("Invalid Bedrock inference profile list");
            for (const profile of profiles.inferenceProfileSummaries) {
                if (!profile || !modelId(profile.inferenceProfileId) || profile.status !== "ACTIVE") continue;
                // The role is the operator's account: its application profiles carry private identifiers.
                if (profile.type !== "SYSTEM_DEFINED" || profile.inferenceProfileId.startsWith("arn:")) continue;
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
        return { ok: false, kind: "upstream", error: new Error(`Amazon Bedrock (IAM) model catalog could not be loaded: ${catalogFailureReason(error)}`) };
    }
}
