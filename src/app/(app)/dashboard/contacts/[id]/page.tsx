import { notFound } from "next/navigation";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getContactDetailProjection, listMergeOptionsProjection } from "@/modules/contacts/server";
import { ContactDetailClient } from "@/modules/contacts/client";
import { listContactPaymentAliasesProjection } from "@/modules/payments/server";
import { ContactPaymentAliases } from "@/modules/payments/client";
import { getContactClearingAccountProjection } from "@/modules/accounts/server";
import { ContactClearingAccountSection } from "@/modules/accounts/client";

/**
 * `/dashboard/contacts/[id]` (fixed path, C2 links to it from a document's own contact
 * badges once it wires the pipeline in). 404s for a contact id that does not exist in the
 * caller's own workspace - `getContactDetailProjection` is already scoped to
 * `access.workspace.id`, never client input, same pattern as
 * `src/app/(app)/dashboard/documents/[id]/page.tsx`.
 */
export default async function ContactDetailPage({ params }: PageProps<"/dashboard/contacts/[id]">) {
  const { id } = await params;
  const access = await requireWorkspaceMember();

  const contact = await getContactDetailProjection(access.workspace.id, id);
  if (!contact) notFound();

  const mergeOptions = await listMergeOptionsProjection(access.workspace.id, id);
  // decisions/0047: names learned from confirmed payments are bank data, finance.read only.
  const canReadFinance = access.permissions.includes(PERMISSIONS.financeRead);
  const paymentAliases = canReadFinance ? await listContactPaymentAliasesProjection(access.workspace.id, id) : [];
  // decisions/0068-supplier-clearing-accounts.md: a supplier whose invoices and bank charges
  // can never pair one to one is settled through a clearing account of its own. Finance data
  // like the learned names above, so the same `finance.read` gate.
  const clearingAccount = canReadFinance ? await getContactClearingAccountProjection(access.workspace.id, id) : null;

  return (
    <div className="flex flex-col gap-6">
      <ContactDetailClient
        contact={contact}
        mergeOptions={mergeOptions}
        canManageCompanyProfile={access.permissions.includes(PERMISSIONS.companyProfileManage)}
      />
      {canReadFinance ? <ContactPaymentAliases aliases={paymentAliases} canManage={access.permissions.includes(PERMISSIONS.financeManage)} /> : null}
      {canReadFinance ? (
        <ContactClearingAccountSection
          contactId={id}
          account={clearingAccount ? { id: clearingAccount.id, name: clearingAccount.name } : null}
          canManage={access.permissions.includes(PERMISSIONS.financeManage)}
        />
      ) : null}
    </div>
  );
}
