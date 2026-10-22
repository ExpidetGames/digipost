"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import {
  addAllowedSenderAction,
  regenerateInboundAddressAction,
  removeAllowedSenderAction,
  setMailIntakeEnabledAction,
  setSenderPolicyAction,
} from "../actions";
import type { MailIntakeActionErrorCode } from "../core/error-codes";
import { SENDER_POLICIES, type SenderPolicy } from "../core/sender-policy";
import type { InboundEmailView, MailIntakeSettingsView } from "../core/types";

/**
 * `/dashboard/email-intake` ("E-Mail-Eingang", decisions/0075-email-intake.md). Every member
 * sees the address, a copy button and how to use it; only `canManage` (the caller's own
 * `mail_intake.manage`, resolved server-side and enforced again by every action) sees the
 * controls and the received-mail log.
 */
export function MailIntakePageClient({
  settings,
  emails,
  canManage,
}: {
  settings: MailIntakeSettingsView;
  emails: InboundEmailView[] | null;
  canManage: boolean;
}) {
  const t = useTranslations("MailIntake");

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {settings.address === null ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">{t("notConfigured")}</p>
      ) : (
        <AddressSection address={settings.address} enabled={settings.enabled} />
      )}

      {canManage && settings.address !== null ? (
        <>
          <AdminControls settings={settings} />
          <SenderPolicySection settings={settings} />
          <InboundLog emails={emails ?? []} />
        </>
      ) : null}
    </div>
  );
}

function AddressSection({ address, enabled }: { address: string; enabled: boolean }) {
  const t = useTranslations("MailIntake");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby="mail-intake-address-heading">
      <h2 id="mail-intake-address-heading" className="text-sm font-semibold text-foreground">
        {t("addressHeading")}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid="mail-intake-address" className="break-all rounded bg-muted px-2 py-1 text-sm text-foreground">
          {address}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      {!enabled ? <p className="text-sm text-destructive">{t("disabledHint")}</p> : null}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t("instructions.forward")}</li>
        <li>{t("instructions.attachments")}</li>
        <li>{t("instructions.limits")}</li>
        <li>{t("instructions.secret")}</li>
      </ul>
    </section>
  );
}

function useActionRunner() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MailIntakeActionErrorCode>();

  function run(action: () => Promise<{ status: "success" } | { status: "error"; errorCode: MailIntakeActionErrorCode }>, onSuccess?: () => void) {
    setError(undefined);
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") {
        setError(result.errorCode);
        return;
      }
      onSuccess?.();
      router.refresh();
    });
  }

  return { pending, error, run };
}

function AdminControls({ settings }: { settings: MailIntakeSettingsView }) {
  const t = useTranslations("MailIntake");
  const tErrors = useTranslations("MailIntake.errors");
  const { pending, error, run } = useActionRunner();
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby="mail-intake-admin-heading">
      <h2 id="mail-intake-admin-heading" className="text-sm font-semibold text-foreground">
        {t("adminHeading")}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => run(() => setMailIntakeEnabledAction({ enabled: !settings.enabled }))}
        >
          {settings.enabled ? t("disable") : t("enable")}
        </Button>
        {confirmingRegenerate ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("regenerateConfirm")}</span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              aria-busy={pending}
              onClick={() => run(() => regenerateInboundAddressAction(), () => setConfirmingRegenerate(false))}
            >
              {t("regenerateConfirmYes")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingRegenerate(false)}>
              {t("cancel")}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingRegenerate(true)}>
            {t("regenerate")}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(error)}
        </p>
      ) : null}
    </section>
  );
}

function SenderPolicySection({ settings }: { settings: MailIntakeSettingsView }) {
  const t = useTranslations("MailIntake");
  const tErrors = useTranslations("MailIntake.errors");
  const { pending, error, run } = useActionRunner();
  const [value, setValue] = useState("");
  // Shown at once, saved in the background; a failed save puts the stored choice back.
  const [selectedPolicy, setSelectedPolicy] = useState<SenderPolicy>(settings.senderPolicy);

  function choose(policy: SenderPolicy) {
    if (policy === selectedPolicy) return;
    setSelectedPolicy(policy);
    run(async () => {
      const result = await setSenderPolicyAction({ policy });
      if (result.status === "error") setSelectedPolicy(settings.senderPolicy);
      return result;
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby="mail-intake-policy-heading">
      <h2 id="mail-intake-policy-heading" className="text-sm font-semibold text-foreground">
        {t("policyHeading")}
      </h2>
      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="sr-only">{t("policyHeading")}</legend>
        {SENDER_POLICIES.map((policy) => (
          <label key={policy} className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="sender-policy"
              value={policy}
              checked={selectedPolicy === policy}
              onChange={() => choose(policy)}
              className="mt-1"
            />
            <span>
              {t(`policies.${policy}.label`)}
              <span className="block text-xs text-muted-foreground">{t(`policies.${policy}.hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {selectedPolicy === "allowlist" ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">{t("allowlistHeading")}</h3>
          <p className="text-xs text-muted-foreground">{t("allowlistHint")}</p>
          {settings.allowedSenders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("allowlistEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {settings.allowedSenders.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
                  <span>
                    {entry.value} <span className="text-xs text-muted-foreground">({t(`senderKinds.${entry.kind}`)})</span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    aria-label={t("removeSenderLabel", { value: entry.value })}
                    onClick={() => run(() => removeAllowedSenderAction({ id: entry.id }))}
                  >
                    {t("removeSender")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => addAllowedSenderAction({ value }), () => setValue(""));
            }}
          >
            <div className="flex min-w-64 flex-1 flex-col gap-1">
              <Label htmlFor="mail-intake-sender">{t("addSenderLabel")}</Label>
              <Input
                id="mail-intake-sender"
                value={value}
                placeholder={t("addSenderPlaceholder")}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
              />
            </div>
            <Button type="submit" size="sm" disabled={pending || value.trim().length === 0}>
              {t("addSender")}
            </Button>
          </form>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(error)}
        </p>
      ) : null}
    </section>
  );
}

function InboundLog({ emails }: { emails: InboundEmailView[] }) {
  const t = useTranslations("MailIntake");
  // A fixed time zone: server (UTC) and browser must render the same text (decisions/0013).
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="mail-intake-log-heading">
      <h2 id="mail-intake-log-heading" className="text-sm font-semibold text-foreground">
        {t("logHeading")}
      </h2>
      <p className="text-xs text-muted-foreground">{t("logHint")}</p>
      {emails.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("logEmpty")}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-normal">{t("columnReceivedAt")}</th>
              <th className="py-2 pr-3 font-normal">{t("columnSender")}</th>
              <th className="py-2 pr-3 font-normal">{t("columnSubject")}</th>
              <th className="py-2 font-normal">{t("columnStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((email) => (
              <tr key={email.id} className="border-b border-border/50 align-top">
                <td className="py-2 pr-3 whitespace-nowrap text-foreground">{dateFormatter.format(new Date(email.receivedAt))}</td>
                <td className="py-2 pr-3 break-all text-foreground">{email.fromAddress}</td>
                <td className="py-2 pr-3 text-foreground">{email.subject ?? t("noSubject")}</td>
                <td className="py-2 text-foreground">
                  <span>{t(`statuses.${email.status}`)}</span>
                  {email.reasonCode ? <span className="block text-xs text-muted-foreground">{t(`reasons.${email.reasonCode}`)}</span> : null}
                  {email.attachments.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {email.attachments.map((attachment) => (
                        <li key={attachment.attachmentId}>
                          {attachment.fileName || t("unnamedAttachment")}: {t(`outcomes.${attachment.outcome}`)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
