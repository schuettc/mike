import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";
import { bedrockCatalogClient } from "../models.bedrock";

// The real SDK, not a mock: the AWS SDK picks bearer auth on its own when
// AWS_BEARER_TOKEN_BEDROCK is set, which only an unmocked client shows.
describe("bedrockCatalogClient", () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.AWS_BEARER_TOKEN_BEDROCK = "stray-test-token";
        process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
        process.env.AWS_SECRET_ACCESS_KEY = "secret-example";
        process.env.AWS_SESSION_TOKEN = "session-example";
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it("signs with SigV4 and ignores a stray AWS_BEARER_TOKEN_BEDROCK", async () => {
        const client = bedrockCatalogClient("us-east-1", "https://bedrock.us-east-1.amazonaws.com");
        let authorization: string | undefined;
        let sessionToken: string | undefined;
        client.middlewareStack.add(
            () => async (args) => {
                const raw = (args.request as { headers: Record<string, string> }).headers;
                const headers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
                authorization = headers.authorization;
                sessionToken = headers["x-amz-security-token"];
                throw new Error("stop before network");
            },
            { step: "finalizeRequest", priority: "low" },
        );
        await expect(client.send(new ListFoundationModelsCommand({}))).rejects.toThrow("stop before network");
        expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
        expect(sessionToken).toBe("session-example");
    });
});
