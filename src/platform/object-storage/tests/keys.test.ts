import { describe, expect, it } from "vitest";

import { documentOriginalKey, documentSearchableKey, InvalidObjectKeySegmentError, workspaceStoragePrefix } from "../index";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("documentOriginalKey", () => {
  it("builds the documented layout", () => {
    expect(documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })).toBe(
      `workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/original.pdf`,
    );
  });

  it("rejects a non-UUID workspace id", () => {
    expect(() => documentOriginalKey({ workspaceId: "../etc", documentId: DOCUMENT_ID })).toThrow(
      InvalidObjectKeySegmentError,
    );
  });

  it("rejects a document id containing a path separator", () => {
    expect(() => documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: "a/b" })).toThrow(
      InvalidObjectKeySegmentError,
    );
  });

  it("rejects an empty segment", () => {
    expect(() => documentOriginalKey({ workspaceId: "", documentId: DOCUMENT_ID })).toThrow(
      InvalidObjectKeySegmentError,
    );
  });

  it("rejects a value that merely looks close to a UUID (wrong length, missing dash)", () => {
    expect(() =>
      documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: "22222222-2222-4222-8222-22222222222" }),
    ).toThrow(InvalidObjectKeySegmentError);
    expect(() =>
      documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: "2222222222224222822222222222222" }),
    ).toThrow(InvalidObjectKeySegmentError);
  });

  it("names the offending field on the error", () => {
    try {
      documentOriginalKey({ workspaceId: "bad/workspace", documentId: DOCUMENT_ID });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidObjectKeySegmentError);
      expect((error as InvalidObjectKeySegmentError).field).toBe("workspaceId");
    }
  });
});

describe("documentSearchableKey", () => {
  it("builds the documented layout", () => {
    expect(documentSearchableKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })).toBe(
      `workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/searchable.pdf`,
    );
  });

  it("rejects a path-traversal document id", () => {
    expect(() =>
      documentSearchableKey({ workspaceId: WORKSPACE_ID, documentId: "../../other-workspace" }),
    ).toThrow(InvalidObjectKeySegmentError);
  });

  it("differs from documentOriginalKey for the same ids", () => {
    const original = documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID });
    const searchable = documentSearchableKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID });
    expect(searchable).not.toBe(original);
  });
});

describe("workspaceStoragePrefix (F5, decisions/0027-hardening-and-deletion.md)", () => {
  it("builds the documented prefix, a leading segment of both key builders above", () => {
    const prefix = workspaceStoragePrefix(WORKSPACE_ID);
    expect(prefix).toBe(`workspaces/${WORKSPACE_ID}/`);
    expect(documentOriginalKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })).toMatch(new RegExp(`^${prefix}`));
    expect(documentSearchableKey({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })).toMatch(new RegExp(`^${prefix}`));
  });

  it("rejects a non-UUID workspace id", () => {
    expect(() => workspaceStoragePrefix("../etc")).toThrow(InvalidObjectKeySegmentError);
  });
});
