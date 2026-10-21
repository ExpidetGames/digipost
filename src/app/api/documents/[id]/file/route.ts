/**
 * `GET /api/documents/[id]/file` (decisions/0015-documents-and-quotas.md): streams the
 * searchable PDF once P2b's processing produced one, otherwise the original upload, for the
 * document detail page's same-origin `<iframe>` embed. Workspace-scoped: a document id from
 * another workspace 404s, never leaking whether it exists (`documents.getFileForDownload`
 * already filters by the caller's own resolved workspace, never client input). `?download=1`
 * asks for `Content-Disposition: attachment` instead of `inline`.
 *
 * Bypasses `src/platform/api-pipeline` deliberately (like `src/app/api/health/route.ts`):
 * this route's contract is a binary PDF stream, not the pipeline's `{ errorCode }` JSON
 * envelope, so adopting it would only add indirection for the one JSON error case (an
 * access failure) this route still needs.
 */
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { contentDispositionHeader } from "@/modules/documents/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/documents/[id]/file">): Promise<Response> {
  const { id } = await context.params;

  let workspaceId: string;
  try {
    const access = await workspaceAccess(PERMISSIONS.documentsRead);
    workspaceId = access.workspace.id;
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      const status = err.code === "unauthenticated" ? 401 : 403;
      return Response.json({ errorCode: err.code }, { status });
    }
    return Response.json({ errorCode: "unknown" }, { status: 500 });
  }

  const file = await getRequestServices().documents.getFileForDownload(workspaceId, id);
  if (!file) {
    return new Response(null, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";

  return new Response(new Blob([file.bytes as BlobPart]), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDispositionHeader(download ? "attachment" : "inline", file.fileName),
      "Cache-Control": "private, no-store",
    },
  });
}
