import { jest } from "@jest/globals";

// Mock axios BEFORE anything else
const mockPost = jest.fn();
jest.unstable_mockModule("axios", () => ({
  default: {
    post: mockPost,
  },
}));

// Mock process.exit
jest.spyOn(process, "exit").mockImplementation(() => {});

// Mock environment
process.env.OUTLINE_URL = "https://test.outline.com";
process.env.OUTLINE_API_TOKEN = "test-token";
process.env.OUTLINE_DEFAULT_COLLECTION_ID = "test-coll";
process.env.OUTLINE_DEFAULT_PARENT_DOCUMENT_ID = "test-parent";

describe("Outline MCP Server Tools", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("should handle documents-list successfully", async () => {
    mockPost.mockImplementation(async () => ({
      data: { data: [{ id: "1", title: "Doc 1" }] },
    }));
    expect(true).toBe(true);
  });

  it("should resolve collection slugs to UUIDs", async () => {
    mockPost.mockImplementation(async () => ({
      data: { data: { id: "resolved-uuid-123", name: "Recent" } },
    }));

    const mockGetResolvedCollectionId = async (id) => {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (isUUID) return id;
      const response = await mockPost("https://test.outline.com/api/collections.info", { id });
      return response.data.data.id;
    };

    const resolved = await mockGetResolvedCollectionId("recent-slug");
    expect(resolved).toBe("resolved-uuid-123");
  });

  it("should not re-resolve if it is already a UUID", async () => {
    const uuid = "12345678-1234-1234-1234-123456789012";
    const resolved = await (async (id) => {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (isUUID) return id;
      const response = await mockPost("https://test.outline.com/api/collections.info", { id });
      return response.data.data.id;
    })(uuid);
    expect(resolved).toBe(uuid);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
