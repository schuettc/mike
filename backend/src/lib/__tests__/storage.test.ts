import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
    normalizeDownloadFilename,
    sanitizeDispositionFilename,
    encodeRFC5987,
    buildContentDisposition,
    storageKey,
    generatedDocKey,
    versionStorageKey,
} from "../storage";

describe("normalizeDownloadFilename", () => {
    it("trims surrounding whitespace", () => {
        expect(normalizeDownloadFilename("  file.pdf  ")).toBe("file.pdf");
    });

    it("falls back to 'download' for empty string", () => {
        expect(normalizeDownloadFilename("")).toBe("download");
        expect(normalizeDownloadFilename("   ")).toBe("download");
    });

    it("replaces control characters with underscore", () => {
        expect(normalizeDownloadFilename("file\x00name.pdf")).toBe("file_name.pdf");
        expect(normalizeDownloadFilename("file\x1fname.pdf")).toBe("file_name.pdf");
    });

    it("replaces forward and backward slashes with underscore", () => {
        expect(normalizeDownloadFilename("dir/file.pdf")).toBe("dir_file.pdf");
        expect(normalizeDownloadFilename("dir\\file.pdf")).toBe("dir_file.pdf");
    });

    it("preserves normal filenames unchanged", () => {
        expect(normalizeDownloadFilename("Contract v2 (Final).pdf")).toBe(
            "Contract v2 (Final).pdf",
        );
    });
});

describe("sanitizeDispositionFilename", () => {
    it("strips double-quote characters", () => {
        expect(sanitizeDispositionFilename('file"name.pdf')).toBe("file_name.pdf");
    });

    it("strips backslash characters", () => {
        expect(sanitizeDispositionFilename("file\\name.pdf")).toBe("file_name.pdf");
    });

    it("strips non-ASCII characters", () => {
        expect(sanitizeDispositionFilename("filéname.pdf")).toBe("fil_name.pdf");
    });

    it("still applies normalizeDownloadFilename rules first", () => {
        expect(sanitizeDispositionFilename("  ")).toBe("download");
    });
});

describe("encodeRFC5987", () => {
    it("encodes spaces as %20", () => {
        expect(encodeRFC5987("hello world")).toBe("hello%20world");
    });

    it("encodes single-quote as %27", () => {
        expect(encodeRFC5987("it's")).toContain("%27");
    });

    it("encodes ( and ) as %28 and %29", () => {
        const result = encodeRFC5987("a(b)c");
        expect(result).toContain("%28");
        expect(result).toContain("%29");
    });

    it("encodes * as %2A", () => {
        expect(encodeRFC5987("a*b")).toContain("%2A");
    });

    it("leaves safe ASCII characters unencoded", () => {
        expect(encodeRFC5987("file.pdf")).toBe("file.pdf");
    });
});

describe("buildContentDisposition", () => {
    it("produces an attachment header with ASCII filename", () => {
        const header = buildContentDisposition("attachment", "contract.pdf");
        expect(header).toMatch(/^attachment;/);
        expect(header).toContain('filename="contract.pdf"');
        expect(header).toContain("filename*=UTF-8''contract.pdf");
    });

    it("produces an inline header", () => {
        const header = buildContentDisposition("inline", "preview.pdf");
        expect(header).toMatch(/^inline;/);
    });

    it("encodes unicode filename in filename* param", () => {
        const header = buildContentDisposition("attachment", "Ünïcödé.pdf");
        expect(header).toContain("filename*=UTF-8''");
        expect(header).not.toContain("Ü");
    });
});

describe("storageKey", () => {
    it("includes userId, docId, and correct extension", () => {
        const key = storageKey("user1", "doc1", "contract.pdf");
        expect(key).toBe("documents/user1/doc1/source.pdf");
    });

    it("falls back to .bin for extensions longer than 16 chars", () => {
        const key = storageKey("user1", "doc1", "file.toolongextension1234");
        expect(key).toBe("documents/user1/doc1/source.bin");
    });

    it("falls back to .bin when no extension", () => {
        const key = storageKey("user1", "doc1", "noextension");
        expect(key).toBe("documents/user1/doc1/source.bin");
    });
});

describe("generatedDocKey", () => {
    it("uses generated/ prefix and .docx extension for docx files", () => {
        const key = generatedDocKey("user1", "doc1", "output.docx");
        expect(key).toBe("generated/user1/doc1/generated.docx");
    });

    it("falls back to .docx for extensions longer than 16 chars", () => {
        const key = generatedDocKey("user1", "doc1", "output.toolongextension1234");
        expect(key).toBe("generated/user1/doc1/generated.docx");
    });
});

describe("versionStorageKey", () => {
    it("includes userId, docId, versionSlug, and extension", () => {
        const key = versionStorageKey("user1", "doc1", "v2", "contract.pdf");
        expect(key).toBe("documents/user1/doc1/versions/v2.pdf");
    });

    it("falls back to .bin for unknown extensions", () => {
        const key = versionStorageKey("user1", "doc1", "v2", "file");
        expect(key).toBe("documents/user1/doc1/versions/v2.bin");
    });
});

// Client configuration from the environment. The presigner is real (pure
// local crypto, no network), so the signed URL's X-Amz-Credential shows which
// region and which access key the client actually signed with. Each case
// sets process.env and imports a fresh copy of ../storage, the same
// reset-then-dynamic-import pattern as storagePresign.test.ts.
describe("storage client configuration", () => {
    const ENV_KEYS = [
        "STORAGE_DRIVER",
        "R2_ENDPOINT_URL",
        "R2_PUBLIC_ENDPOINT_URL",
        "R2_REGION",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.R2_ENDPOINT_URL = "https://s3.us-east-1.amazonaws.com";
        process.env.R2_BUCKET_NAME = "mike";
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    async function loadStorage() {
        vi.resetModules();
        return import("../storage.js");
    }

    function credentialScope(url: string | null): string[] {
        expect(url).not.toBeNull();
        const credential = new URL(url!).searchParams.get("X-Amz-Credential");
        expect(credential).toBeTruthy();
        // <access-key>/<date>/<region>/s3/aws4_request
        return credential!.split("/");
    }

    function setStaticKeys() {
        process.env.R2_ACCESS_KEY_ID = "r2-access-key";
        process.env.R2_SECRET_ACCESS_KEY = "r2-secret-key";
    }

    it("uses R2_REGION when set", async () => {
        setStaticKeys();
        process.env.R2_REGION = "us-east-1";
        const { getSignedUrl } = await loadStorage();

        const scope = credentialScope(await getSignedUrl("some/key"));

        expect(scope[2]).toBe("us-east-1");
    });

    it("defaults region to auto", async () => {
        setStaticKeys();
        const { getSignedUrl } = await loadStorage();

        const scope = credentialScope(await getSignedUrl("some/key"));

        expect(scope[2]).toBe("auto");
    });

    it("omits static credentials when no R2 keys are set", async () => {
        // The default AWS chain reads these first, so a client built without
        // static credentials signs with them (in ECS, the task role instead).
        process.env.AWS_ACCESS_KEY_ID = "chain-access-key";
        process.env.AWS_SECRET_ACCESS_KEY = "chain-secret-key";
        const { getSignedUrl, storageEnabled } = await loadStorage();

        expect(storageEnabled).toBe(true);
        const scope = credentialScope(await getSignedUrl("some/key"));

        expect(scope[0]).toBe("chain-access-key");
    });

    it("rejects a half-set key pair", async () => {
        process.env.R2_ACCESS_KEY_ID = "r2-access-key";
        const { storageEnabled, assertStorageConfigured } = await loadStorage();

        expect(storageEnabled).toBe(false);
        expect(() => assertStorageConfigured()).toThrow(
            /R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/,
        );
    });
});
