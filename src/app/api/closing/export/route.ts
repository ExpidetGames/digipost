/**
 * `GET /api/closing/export?period=2026-01` (decisions/0066-abschluss-check-and-export.md):
 * streams the Abschluss export - one ZIP holding `uebersicht.xlsx` (three sheets: the
 * period's documents, its transactions, and the confirmed pairings between them, German
 * headers, real dates and real numbers) plus every document's own file, the searchable PDF
 * where processing produced one and the original upload otherwise:
 * `ausgangsrechnungen/<file>` for a document the workspace issued itself, `belege/<file>`
 * for everything else.
 *
 * Admin-only, the same gate as the rest of the finance area: `workspaceAccess(
 * PERMISSIONS.financeRead)`. Workspace-scoped from the resolved session, never from client
 * input - the only thing the client may choose is the period, and that is parsed by
 * `@/modules/closing`'s own `readClosingPeriod` before it ever reaches SQL.
 *
 * Bypasses `src/platform/api-pipeline` deliberately, exactly like
 * `src/app/api/documents/[id]/file/route.ts`: this route's contract is a binary stream, not
 * the pipeline's `{ errorCode }` JSON envelope, so adopting it would only add indirection
 * for the error cases (which still answer plain `{ errorCode }` JSON).
 */
import { getTranslations } from "next-intl/server";

import { readClosingPeriod } from "@/modules/closing";
import { createClosingExport, type ClosingExportLabels } from "@/modules/closing/server";
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";

export const dynamic = "force-dynamic";
// The archive is produced one document at a time (see `export-archive.ts`), so the wall
// clock is dominated by object-storage round trips, not by CPU. 60s is the same ceiling the
// cron routes use; a period large enough to exceed it is the practical size limit this
// module's README names.
export const maxDuration = 60;

type ClosingExportErrorCode = "unauthenticated" | "forbidden" | "invalid_period" | "unknown";

function errorResponse(errorCode: ClosingExportErrorCode, status: number): Response {
  return Response.json({ errorCode }, { status });
}

export async function GET(request: Request): Promise<Response> {
  let workspaceId: string;
  try {
    const access = await workspaceAccess(PERMISSIONS.financeRead);
    workspaceId = access.workspace.id;
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return errorResponse(err.code === "unauthenticated" ? "unauthenticated" : "forbidden", err.code === "unauthenticated" ? 401 : 403);
    }
    return errorResponse("unknown", 500);
  }

  const period = readClosingPeriod({ period: new URL(request.url).searchParams.get("period") ?? undefined });
  // Unlike the page, the route does NOT fall back to a default period: a download is an
  // explicit act, and silently handing back a different month than the one asked for would
  // be worse than refusing.
  if (!period) return errorResponse("invalid_period", 400);

  const [tExport, tKinds, tPlatforms, tInbox, tPayments] = await Promise.all([
    getTranslations("Closing.export"),
    getTranslations("DocumentKinds"),
    getTranslations("SettlementPlatforms"),
    getTranslations("Inbox"),
    getTranslations("Payments"),
  ]);

  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium" });
  const monthFormatter = new Intl.DateTimeFormat("de", { month: "long", year: "numeric" });
  const amountFormatter = (currency: string): Intl.NumberFormat =>
    new Intl.NumberFormat("de", { style: "currency", currency, currencyDisplay: "code" });

  /** A confirmed counterpart with no "Nr." in this workbook, named by its own date and
   * amount: "außerhalb des Zeitraums (14.12.2025, 23,00 EUR)". An amount can genuinely be
   * missing (a document that carries none at all), and then the date alone has to do. */
  const describeCounterpart =
    (withAmount: "outsidePeriod" | "notListed", withoutAmount: "outsidePeriodWithoutAmount" | "notListedWithoutAmount") =>
    ({ isoDate, amountCents, currency }: { isoDate: string; amountCents: number | null; currency: string | null }): string => {
      const date = dateFormatter.format(new Date(`${isoDate}T00:00:00`));
      if (amountCents === null) return tExport(withoutAmount, { date });
      return tExport(withAmount, { date, amount: amountFormatter(currency ?? "EUR").format(amountCents / 100) });
    };

  const labels: ClosingExportLabels = {
    documentsSheetName: tExport("documentsSheet"),
    transactionsSheetName: tExport("transactionsSheet"),
    assignmentsSheetName: tExport("assignmentsSheet"),
    documentColumns: {
      reference: tExport("documentColumns.reference"),
      date: tExport("documentColumns.date"),
      name: tExport("documentColumns.name"),
      counterparty: tExport("documentColumns.counterparty"),
      kind: tExport("documentColumns.kind"),
      direction: tExport("documentColumns.direction"),
      amount: tExport("documentColumns.amount"),
      currency: tExport("documentColumns.currency"),
      invoiceNumber: tExport("documentColumns.invoiceNumber"),
      paymentStatus: tExport("documentColumns.paymentStatus"),
      matchedTransactions: tExport("documentColumns.matchedTransactions"),
      file: tExport("documentColumns.file"),
    },
    transactionColumns: {
      reference: tExport("transactionColumns.reference"),
      date: tExport("transactionColumns.date"),
      account: tExport("transactionColumns.account"),
      amount: tExport("transactionColumns.amount"),
      currency: tExport("transactionColumns.currency"),
      counterparty: tExport("transactionColumns.counterparty"),
      purpose: tExport("transactionColumns.purpose"),
      matchedDocuments: tExport("transactionColumns.matchedDocuments"),
      status: tExport("transactionColumns.status"),
    },
    assignmentColumns: {
      documentReference: tExport("assignmentColumns.documentReference"),
      documentDate: tExport("assignmentColumns.documentDate"),
      document: tExport("assignmentColumns.document"),
      documentAmount: tExport("assignmentColumns.documentAmount"),
      currency: tExport("assignmentColumns.currency"),
      transactionReference: tExport("assignmentColumns.transactionReference"),
      transactionDate: tExport("assignmentColumns.transactionDate"),
      transactionAmount: tExport("assignmentColumns.transactionAmount"),
      allocatedAmount: tExport("assignmentColumns.allocatedAmount"),
    },
    reference: {
      outsidePeriod: describeCounterpart("outsidePeriod", "outsidePeriodWithoutAmount"),
      notListed: describeCounterpart("notListed", "notListedWithoutAmount"),
    },
    transactionStatus: {
      matched: tExport("transactionStatus.matched"),
      noDocumentNeeded: tExport("transactionStatus.noDocumentNeeded"),
      open: tExport("transactionStatus.open"),
    },
    documentKind: (kind) => tKinds(kind),
    direction: (direction) => tInbox(`directionValues.${direction}`),
    paymentStatus: (status) => tPayments(`statusValues.${status}`),
    name: {
      platformLabel: (platform) => tPlatforms(platform),
      bankStatementLabel: tKinds("bank_statement"),
      receivedOnLabel: (formattedDate) => tInbox("receivedOn", { date: formattedDate }),
      formatDate: (isoDate) => dateFormatter.format(new Date(`${isoDate}T00:00:00`)),
      formatMonth: (isoMonth) => monthFormatter.format(new Date(`${isoMonth}-01T00:00:00`)),
    },
  };

  try {
    const { fileName, body } = await createClosingExport(workspaceId, period, labels);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        // Pure ASCII by construction (`abschluss-2026-01.zip`), so no `filename*` encoding
        // dance is needed here the way it is for a user-supplied document name.
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[closing] export failed", err);
    return errorResponse("unknown", 500);
  }
}
