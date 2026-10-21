// The 80% quota warning e-mail (architecture brief: "Warning email to the admin at 80% of
// either limit, at most once per limit per calendar month",
// decisions/0017-billing-tiers-and-packages.md): sent as an outbox job (`send-quota-warning`)
// by `src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated` whenever a
// threshold is crossed for the first time in a calendar month. `STRUCTURE.md`'s `vendor-sdk`
// rule confines `@react-email/` to this directory plus `src/platform/auth/server/emails/`,
// `src/platform/mailer/`, `src/modules/workspaces/server/emails/`, and
// `src/modules/documents/server/emails/`.
import "server-only";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

import { renderEmail, type RenderedEmail } from "@/platform/mailer/server";

// German copy, hardcoded here rather than through next-intl (decisions/0013-german-ui-language.md):
// this renders from a job handler, outside any request-scoped next-intl context.
export function quotaWarningEmailSubject(limit: "total" | "monthly"): string {
  return limit === "total" ? "Digipost: Speicherlimit bald erreicht" : "Digipost: Monatliches Limit bald erreicht";
}

export type QuotaWarningEmailProps = {
  workspaceName: string;
  limit: "total" | "monthly";
  /** Documents currently stored (for `limit: "total"`) or created this month (for
   * `limit: "monthly"`). */
  current: number;
  /** The limit `current` is approaching - the tier's total limit, or the effective monthly
   * limit (tier + any package capacity) for `limit: "monthly"`. */
  max: number;
  url: string;
};

function limitLabel(limit: "total" | "monthly"): string {
  return limit === "total" ? "Speicherlimit (Gesamtanzahl Dokumente)" : "monatliches Limit für neue Dokumente";
}

function QuotaWarningEmail({ workspaceName, limit, current, max, url }: QuotaWarningEmailProps) {
  return (
    <Html lang="de">
      <Head />
      <Preview>{`${workspaceName}: ${limitLabel(limit)} ist zu ${Math.round((current / max) * 100)}% ausgeschöpft`}</Preview>
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f4f5", padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "32px", maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", margin: "0 0 16px" }}>
            Digipost
          </Heading>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            Ihr Arbeitsbereich &quot;{workspaceName}&quot; nähert sich dem {limitLabel(limit)}: {current} von {max} Dokumenten.
          </Text>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            {limit === "total"
              ? "Löschen Sie nicht mehr benötigte Dokumente oder erweitern Sie Ihren Tarif, damit weiterhin Post erfasst werden kann."
              : "Erweitern Sie Ihren Tarif oder kaufen Sie ein Digitalisierungspaket, damit in diesem Monat weiterhin Post erfasst werden kann."}
          </Text>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            <Link href={url} style={{ color: "#111827", fontWeight: 600 }}>
              Zu Tarif & Nutzung
            </Link>
          </Text>
          <Text style={{ fontSize: "12px", color: "#6b7280", marginTop: "24px" }}>
            Oder fügen Sie diesen Link in Ihren Browser ein:
            <br />
            {url}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderQuotaWarningEmail(props: QuotaWarningEmailProps): Promise<RenderedEmail> {
  return renderEmail(<QuotaWarningEmail {...props} />);
}
