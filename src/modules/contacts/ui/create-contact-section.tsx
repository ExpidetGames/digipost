"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { ContactForm } from "./contact-form";

/** The `/dashboard/contacts` list page's "Kontakt anlegen" toggle (scope item 1). Redirects
 * to the new contact's own detail page on success, same UX as `OnboardingForm`'s
 * `router.push` after a successful create. */
export function CreateContactSection() {
  const t = useTranslations("Contacts");
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        {t("createCta")}
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{t("createHeading")}</h2>
      <ContactForm mode="create" onCancel={() => setOpen(false)} onSuccess={(id) => router.push(`/dashboard/contacts/${id}`)} />
    </div>
  );
}
