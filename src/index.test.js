import { jest } from "@jest/globals";

// Mock axios
jest.unstable_mockModule("axios", () => ({
  default: {
    post: jest.fn(),
    put: jest.fn(),
  },
}));

// Mock fs
const globalFsMock = {
  existsSync: jest.fn(),
  statSync: jest.fn(),
  createReadStream: jest.fn(),
  realpathSync: jest.fn(),
};
jest.unstable_mockModule("fs", () => ({
  default: globalFsMock,
  ...globalFsMock,
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
  let getTools;
  let axiosMock;
  let fsMock;
  let mod;

  beforeAll(async () => {
    mod = await import("./index.js");
    handleCallTool = mod.handleCallTool;
    getTools = mod.getTools;
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
        text: 'See video: ![Alt](/api/attachments.redirect?id=attach-video "My Video") or [Download](/api/attachments.redirect?id=attach-video)\n',
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

  it("should use signed multipart upload fields as provided by Outline", async () => {
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            uploadUrl: "https://s3.test/upload-post",
            form: { key: "uploads/test.png", "x-amz-meta-tag": ["a", "b"] },
            attachment: { id: "attach-form" },
          },
        },
      })
      .mockResolvedValueOnce({ status: 204 })
      .mockResolvedValueOnce({ data: { data: { id: "doc-form", title: "Form Doc" } } });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Form Doc",
          text: "![img](image.png)",
          attachments: [
            {
              name: "image.png",
              contentType: "image/png",
              content: Buffer.from("img").toString("base64"),
            },
          ],
        },
      },
    };

    await handleCallTool(request, config);

    expect(axiosMock.post).toHaveBeenCalledWith(
      "https://s3.test/upload-post",
      expect.any(Object),
      expect.objectContaining({
        timeout: expect.any(Number),
      }),
    );
  });

  it("should include signed upload response details when upload fails", async () => {
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            uploadUrl: "https://s3.test/upload",
            attachment: { id: "attach-err" },
          },
        },
      });
    axiosMock.put.mockRejectedValueOnce({
      message: "Request failed with status code 403",
      response: { status: 403, data: "SignatureDoesNotMatch" },
    });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Broken Upload",
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
      /Signed upload failed: status=403 \| SignatureDoesNotMatch/,
    );
  });

  it("should support link destinations wrapped in angle brackets", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ size: 3 });
    fsMock.createReadStream.mockReturnValue({ pipe: jest.fn() });

    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            uploadUrl: "https://s3.test/upload",
            attachment: { id: "attach-angle" },
          },
        },
      });
    axiosMock.put.mockResolvedValueOnce({ status: 200 });
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-angle", title: "Angle Doc" } },
    });

    await handleCallTool(
      {
        params: {
          name: "documents-upsert",
          arguments: {
            title: "Angle Doc",
            text: '![Alt](<image.png> "Img") and [Download](</tmp/image.png>)',
            attachments: [
              {
                name: "image.png",
                path: "/tmp/image.png",
              },
            ],
          },
        },
      },
      config,
    );

    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents.create"),
      expect.objectContaining({
        text: '![Alt](/api/attachments.redirect?id=attach-angle "Img") and [Download](/api/attachments.redirect?id=attach-angle)\n',
      }),
      expect.any(Object),
    );
  });

  it("should advertise short IDs/URLs in tool schemas and enforce attachment oneOf", () => {
    const tools = getTools("sandbox-collection");
    const listTool = tools.find((tool) => tool.name === "documents-list");
    const getTool = tools.find((tool) => tool.name === "documents-get");
    const upsertTool = tools.find((tool) => tool.name === "documents-upsert");

    expect(listTool.inputSchema.properties.collectionId.format).toBeUndefined();
    expect(listTool.inputSchema.properties.collectionId.description).toContain(
      "short ID",
    );

    expect(getTool.inputSchema.properties.id.description).toContain("short ID");
    expect(upsertTool.inputSchema.properties.parentDocumentId.format).toBeUndefined();
    expect(upsertTool.inputSchema.properties.attachments.items.oneOf).toHaveLength(2);
  });

  it("should handle documents-patch with surgical search and replace", async () => {
    // 1. Mock parent info (for resolution)
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
    });

    // 2. Mock documents.info (to get original text)
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          id: "doc-123",
          title: "Existing Doc",
          text: "Original content. Keep this.",
          collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc",
        },
      },
    });

    // 3. Mock documents.update
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-123", title: "Existing Doc" } },
    });

    const request = {
      params: {
        name: "documents-patch",
        arguments: {
          id: "doc-123",
          patches: [
            {
              search: "Original content.",
              replace: "Patched content!",
            },
          ],
        },
      },
    };

    const result = await handleCallTool(request, config);

    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents.update"),
      expect.objectContaining({
        text: "Patched content! Keep this.",
      }),
      expect.any(Object),
    );
    expect(result.isError).toBeUndefined();
  });

  it("should fail documents-patch if search string is not found", async () => {
    // 1. Mock parent info
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
    });

    // 2. Mock documents.info
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          id: "doc-123",
          text: "I am here.",
          collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc",
        },
      },
    });

    const request = {
      params: {
        name: "documents-patch",
        arguments: {
          id: "doc-123",
          patches: [{ search: "Not here", replace: "X" }],
        },
      },
    };

    await expect(handleCallTool(request, config)).rejects.toThrow(
      "Patch failed: Could not find exact search string",
    );
  });

  it("should fail documents-patch if search string is ambiguous", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          id: "doc-123",
          text: "Double Double",
          collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc",
        },
      },
    });

    const request = {
      params: {
        name: "documents-patch",
        arguments: {
          id: "doc-123",
          patches: [{ search: "Double", replace: "X" }],
        },
      },
    };

    await expect(handleCallTool(request, config)).rejects.toThrow(
      "Search string is ambiguous and matches 2 times",
    );
  });

  it("should handle special $ characters in documents-patch replacement", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          id: "doc-123",
          title: "Price Doc",
          text: "The price is PLACEHOLDER.",
          collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc",
        },
      },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-123", title: "Price Doc" } },
    });

    const request = {
      params: {
        name: "documents-patch",
        arguments: {
          id: "doc-123",
          patches: [{ search: "PLACEHOLDER", replace: "$100" }],
        },
      },
    };

    await handleCallTool(request, config);

    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents.update"),
      expect.objectContaining({
        text: "The price is $100.",
      }),
      expect.any(Object),
    );
  });

  it("should normalize newlines in documents-patch", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: {
        data: {
          id: "doc-123",
          title: "NL Doc",
          text: "Line 1\r\nLine 2",
          collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc",
        },
      },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-123", title: "NL Doc" } },
    });

    const request = {
      params: {
        name: "documents-patch",
        arguments: {
          id: "doc-123",
          patches: [{ search: "Line 1\nLine 2", replace: "Fixed" }],
        },
      },
    };

    await handleCallTool(request, config);

    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents.update"),
      expect.objectContaining({
        text: "Fixed",
      }),
      expect.any(Object),
    );
  });

  it("should format new documents with Prettier in documents-upsert", async () => {
    // 1. Mock parent info (resolution + sandbox check)
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      });

    // 2. Mock document create
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-new", title: "New Doc" } },
    });

    const messyMarkdown = "  # Heading\n\n- item 1\n - item 2";
    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "New Doc",
          text: messyMarkdown,
        },
      },
    };

    await handleCallTool(request, config);

    // Verify axios call text (formatted by Prettier)
    const call = axiosMock.post.mock.calls.find((c) =>
      c[0].endsWith("/api/documents.create"),
    );
    const sentText = call[1].text;

    expect(sentText).toContain("# Heading");
    expect(sentText).toContain("- item 1\n- item 2"); // Normalized indentation
    expect(sentText).not.toBe(messyMarkdown);
  });

  it("should fail validation if attachment placeholders remain", async () => {
    // 1. Mock parent info
    axiosMock.post
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      })
      .mockResolvedValueOnce({
        data: { data: { id: "e5583450-d16e-4401-9cfb-5efd0c49320f", collectionId: "ad1f9489-44b8-4396-8850-6c45496781cc" } },
      });

    // 2. Mock document create
    axiosMock.post.mockResolvedValueOnce({
      data: { data: { id: "doc-fail", title: "Fail Doc" } },
    });

    const request = {
      params: {
        name: "documents-upsert",
        arguments: {
          title: "Fail Doc",
          text: "Dangling {{attachment:missing.png}}",
        },
      },
    };

    await expect(handleCallTool(request, config)).rejects.toThrow(
      "Found unreplaced attachment placeholder",
    );
  });
});
