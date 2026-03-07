import { jest } from "@jest/globals";

// Mock axios
jest.unstable_mockModule("axios", () => ({
  default: {
    post: jest.fn(),
    put: jest.fn(),
  },
}));

// Mock fs
jest.unstable_mockModule("fs", () => ({
  default: {
    existsSync: jest.fn(),
    statSync: jest.fn(),
    createReadStream: jest.fn(),
    realpathSync: jest.fn(),
  },
}));

// Mock process.exit
jest.spyOn(process, "exit").mockImplementation(() => {});

// Mock environment
process.env.NODE_ENV = "test";
process.env.OUTLINE_URL = "https://test.outline.com";
process.env.OUTLINE_API_TOKEN = "test-token";
process.env.OUTLINE_DEFAULT_COLLECTION_ID = "ad1f9489-44b8-4396-8850-6c45496781cc";
process.env.OUTLINE_DEFAULT_PARENT_DOCUMENT_ID = "e5583450-d16e-4401-9cfb-5efd0c49320f";

const config = {
  outlineUrl: process.env.OUTLINE_URL,
  outlineToken: process.env.OUTLINE_API_TOKEN,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
};

describe("Outline MCP Server Tools - Attachments", () => {
  let handleCallTool;
  let axiosMock;
  let fsMock;
  let mod;

  beforeAll(async () => {
    mod = await import("./index.js");
    handleCallTool = mod.handleCallTool;
    const { default: axios } = await import("axios");
    axiosMock = axios;
    const { default: fs } = await import("fs");
    fsMock = fs;
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Reset internal state for identifiers resolution
    if (mod && mod.getCONFIG) {
      const internalConfig = mod.getCONFIG();
      internalConfig.isResolved = false;
      internalConfig.resolvedCollectionId = null;
      internalConfig.resolvedParentDocumentId = null;
    }
  });

  it("should handle documents-upsert with base64 attachments", async () => {
    // 1. Mock parent info (sandboxing check - called TWICE: once for resolution, once for sandboxing)
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      });

    // 2. Mock attachment create
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          uploadUrl: "https://s3.test/upload",
          attachment: { id: "attach-123" },
        },
      },
    });

    // 3. Mock attachment PUT upload
    axiosMock.put.mockResolvedValueOnce({ status: 200 });

    // 4. Mock document create
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-123", title: "Test Doc" } },
    });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Test Doc",
          text: "Here is an attachment: {{attachment:image.png}}",
          attachments: [
            {
              name: "image.png",
              contentType: "image/png",
              content: Buffer.from("test content").toString("base64"),
            },
          ],
        },
      },
    };

    const result = await handleCallTool(request, config);

    // Verify axios calls
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/attachments.create"),
      expect.objectContaining({ name: "image.png" }),
      expect.any(Object),
    );

    expect(axiosMock.put).toHaveBeenCalledWith(
      "https://s3.test/upload",
      expect.any(Buffer),
      expect.any(Object),
    );

    expect(JSON.parse(result.content[0].text).attachments[0].id).toBe("attach-123");
  });

  it("should handle documents-upsert with path-based attachments and standard markdown", async () => {
    // Mock FS
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ size: 1024 });
    const mockStream = { pipe: jest.fn() };
    fsMock.createReadStream.mockReturnValue(mockStream);

    // 1. Mock parent info
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      });

    // 2. Mock attachment create
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          uploadUrl: "https://s3.test/upload",
          attachment: { id: "attach-video" },
        },
      },
    });

    // 3. Mock attachment PUT upload
    axiosMock.put.mockResolvedValueOnce({ status: 200 });

    // 4. Mock document create
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-video", title: "Video Doc" } },
    });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Video Doc",
          text: 'See video: ![Alt](movie.mp4 "My Video") or [Download](  /path/to/movie.mp4  )',
          attachments: [
            {
              path: "/path/to/movie.mp4",
            },
          ],
        },
      },
    };

    const result = await handleCallTool(request, config);

    // Verify document create (with replaced standard markdown links)
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents.create"),
      expect.objectContaining({
        text: 'See video: ![Alt](/api/attachments.redirect?id=attach-video "My Video") or [Download](  /api/attachments.redirect?id=attach-video  )',
      }),
      expect.any(Object),
    );

    expect(JSON.parse(result.content[0].text).attachments[0].id).toBe("attach-video");
  });

  it("should fail fast when attachments.create response is unexpected", async () => {
    // 1. Mock parent info
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      });

    // 2. Mock bad attachment create response
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { attachment: {} } }, // Missing id and uploadUrl
    });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Bad Attachment",
          text: "x",
          attachments: [
            {
              name: "image.png",
              contentType: "image/png",
              content: Buffer.from("test content").toString("base64"),
            },
          ],
        },
      },
    };

    await expect(handleCallTool(request, config)).rejects.toThrow(
      "missing required 'attachment.id' or 'uploadUrl'",
    );
  });
});

import fc from "fast-check";

describe("Markdown Replacement Fuzzing", () => {
  let replaceInMarkdown;

  beforeAll(async () => {
    const escapeRegExp = (string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    replaceInMarkdown = (text, target, replacement, isImage) => {
      const prefix = isImage ? "!" : "";
      const regex = new RegExp(
        `(${prefix}\\[.*?\\])\\((\\s*)${escapeRegExp(target)}(\\s+.*?)?(\\s*)\\)`,
        "g",
      );
      return text.replace(regex, `$1($2${replacement}$3$4)`);
    };
  });

  it("should never crash and always replace valid placeholders", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.uuid(),
        (text, filename, id) => {
          try {
            const result = replaceInMarkdown(text, filename, id, true);
            return typeof result === "string";
          } catch {
            return false;
          }
        },
      ),
    );
  });
});
