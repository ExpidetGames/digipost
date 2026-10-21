import { AlertTriangle } from "lucide-react";

// An unmissable warning banner (this phase's brief) shared by /legal-notice and /privacy:
// both pages ship only placeholder legal text (TODO-marked company data, a Datenschutzerklärung
// that has not been reviewed by a lawyer) and must never be mistaken for final legal copy.
// `role="alert"` plus strong visual contrast (destructive-tinted border/background) makes
// this the first thing both a sighted visitor and a screen reader announce.
export function LegalDraftBanner({ heading, body }: { heading: string; body: string }) {
  return (
    <div role="alert" className="mt-6 flex items-start gap-3 rounded-lg border-2 border-destructive/50 bg-destructive/10 px-4 py-3">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div>
        <p className="text-sm font-semibold text-destructive">{heading}</p>
        <p className="mt-1 text-sm text-foreground">{body}</p>
      </div>
    </div>
  );
}
