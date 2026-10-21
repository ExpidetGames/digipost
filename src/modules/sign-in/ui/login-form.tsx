"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { requestMagicLinkAction, type RequestMagicLinkState } from "../actions";
import { resolveCallbackErrorCode } from "../core/error-codes";

const INITIAL_STATE: RequestMagicLinkState = { status: "idle" };

export function LoginForm({ next, initialErrorCode }: { next?: string; initialErrorCode?: string }) {
  const t = useTranslations("Login");
  const [state, formAction, pending] = useActionState(requestMagicLinkAction, INITIAL_STATE);
  const [email, setEmail] = useState("");
  // The "sent" result the user dismissed via "Use a different e-mail address".
  const [dismissedState, setDismissedState] = useState<RequestMagicLinkState | null>(null);

  if (state.status === "sent" && state !== dismissedState) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-foreground">{t("sentHeading")}</h2>
        <p className="text-sm text-muted-foreground">{t("sentDescription", { email: state.email })}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setEmail("");
            setDismissedState(state);
          }}
        >
          {t("useDifferentEmail")}
        </Button>
      </div>
    );
  }

  const actionErrorCode = state.status === "error" ? state.errorCode : undefined;
  const fallbackErrorCode = state === INITIAL_STATE ? resolveCallbackErrorCode(initialErrorCode) : undefined;
  const errorCode = actionErrorCode ?? fallbackErrorCode;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={errorCode ? true : undefined}
        />
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? t("submitPending") : t("submit")}
      </Button>
    </form>
  );
}
