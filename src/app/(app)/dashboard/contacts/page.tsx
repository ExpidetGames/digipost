import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireWorkspaceMember } from "@/platform/access/server";
import { CONTACT_RELATION_TYPES, contactListQuerySchema } from "@/modules/contacts";
import { listContactsProjection, listPendingProposalsSummaryProjection } from "@/modules/contacts/server";
import { CreateContactSection } from "@/modules/contacts/client";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Preserves every other filter while changing only `page` (pagination links) - same
 * pattern as `src/app/(app)/dashboard/page.tsx`'s own `pageHref`. */
function pageHref(rawParams: Record<string, string | string[] | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === "page") continue;
    const first = firstParam(value);
    if (first) params.set(key, first);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/dashboard/contacts?${query}` : "/dashboard/contacts";
}

/**
 * "Kontakte" (decisions/0019-contacts.md, C3): search (name, VAT id, customer number),
 * `relation_type`/"Nur unbestätigte" filters, counts of linked documents and pending
 * proposals per row, an "unbestätigt" badge, and a global entry point to pending proposals
 * (scope item 3) via the "Änderungsvorschläge" section below the filters. Filter/pagination
 * state lives entirely in the URL, a plain `method="get"` form, same convention as the
 * documents inbox (`src/app/(app)/dashboard/page.tsx`) - only the "Kontakt anlegen" toggle
 * needs client JS.
 */
export default async function ContactsPage({ searchParams }: PageProps<"/dashboard/contacts">) {
  const access = await requireWorkspaceMember();
  const rawParams = await searchParams;

  const parsed = contactListQuerySchema.safeParse({
    q: firstParam(rawParams.q),
    relationType: firstParam(rawParams.relationType),
    unverified: firstParam(rawParams.unverified),
    page: firstParam(rawParams.page),
  });
  const query = parsed.success ? parsed.data : { page: 1 as number };

  const [t, tRelation, tFields, list, pendingProposals] = await Promise.all([
    getTranslations("Contacts"),
    getTranslations("Contacts.relationTypeValues"),
    getTranslations("Contacts.fieldLabels"),
    listContactsProjection(access.workspace.id, {
      q: query.q,
      relationType: query.relationType,
      onlyUnverified: query.unverified === "1",
      page: query.page,
    }),
    listPendingProposalsSummaryProjection(access.workspace.id),
  ]);

  const hasFilters = Boolean(query.q || query.relationType || query.unverified);
  const controlClasses = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <CreateContactSection />
      </div>

      {pendingProposals.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <h2 className="text-sm font-semibold text-foreground">{t("proposalsHeading", { count: pendingProposals.length })}</h2>
          <ul className="flex flex-col gap-1">
            {pendingProposals.slice(0, 10).map((proposal) => (
              <li key={proposal.id} className="text-sm text-foreground">
                <Link href={`/dashboard/contacts/${proposal.contactId}`} className="underline">
                  {proposal.contactName}
                </Link>
                {": "}
                {tFields.has(proposal.field) ? tFields(proposal.field) : proposal.field}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="contacts-q" className="text-xs text-muted-foreground">
            {t("filters.searchLabel")}
          </label>
          <input
            id="contacts-q"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder={t("filters.searchPlaceholder")}
            className={controlClasses}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="contacts-relationType" className="text-xs text-muted-foreground">
            {t("filters.relationTypeLabel")}
          </label>
          <select id="contacts-relationType" name="relationType" defaultValue={query.relationType ?? ""} className={controlClasses}>
            <option value="">{t("filters.allRelationTypes")}</option>
            {CONTACT_RELATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {tRelation(type)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm text-foreground">
          <input type="checkbox" name="unverified" value="1" defaultChecked={query.unverified === "1"} />
          {t("filters.onlyUnverified")}
        </label>
        <button
          type="submit"
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          {t("filters.submit")}
        </button>
        {hasFilters ? (
          <Link href="/dashboard/contacts" className="text-sm text-muted-foreground underline">
            {t("filters.reset")}
          </Link>
        ) : null}
      </form>

      {list.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{hasFilters ? t("emptyFiltered") : t("emptyState")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.items.map((contact) => (
            <li key={contact.id}>
              <Link
                href={`/dashboard/contacts/${contact.id}`}
                className="flex flex-col gap-1 rounded-lg border border-border p-3 hover:bg-muted sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-foreground">{contact.name}</p>
                  {!contact.verified ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      {t("unverifiedBadge")}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {contact.relationType ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{tRelation(contact.relationType)}</span>
                  ) : null}
                  {contact.vatId ? <span>{contact.vatId}</span> : null}
                  <span>{t("documentsCount", { count: contact.documentsCount })}</span>
                  {contact.pendingProposalsCount > 0 ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                      {t("pendingProposalsCount", { count: contact.pendingProposalsCount })}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.items.length > 0 && (query.page > 1 || list.hasMore) ? (
        <div className="flex justify-between">
          {query.page > 1 ? (
            <Link href={pageHref(rawParams, query.page - 1)} className="text-sm text-foreground underline">
              {t("pagination.previous")}
            </Link>
          ) : (
            <span />
          )}
          {list.hasMore ? (
            <Link href={pageHref(rawParams, query.page + 1)} className="text-sm text-foreground underline">
              {t("pagination.next")}
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
