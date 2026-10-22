// The admin's "a mail to the E-Mail-Eingang was not imported" e-mail
// (decisions/0075-email-intake.md), sent by the `send-mail-intake-notification` job at most
// once per workspace and reason per 24 hours. `STRUCTURE.md`'s `vendor-sdk` rule allows
// `@react-email/` in this directory.
import "server-only";

import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "@react-email/components";

import { renderEmail, type RenderedEmail } from "@/platform/mailer/server";

import type { NotifiedReason } from "../../core/inbound-email";

// German copy, hardcoded rather than through next-intl (decisions/0013-german-ui-language.md):
// rendered from a job handler, outside any request-scoped next-intl context.
const SUBJECTS: Record<NotifiedReason, string> = {
  sender_not_allowed: "Digipost: E-Mail von unbekanntem Absender abgelehnt",
  sender_not_authenticated: "Digipost: E-Mail mit nicht bestätigtem Absender abgelehnt",
  no_supported_attachment: "Digipost: E-Mail ohne verwertbaren Anhang",
  quota_exceeded: "Digipost: E-Mail-Anhänge wegen Kontingent nicht importiert",
};

const EXPLANATIONS: Record<NotifiedReason, string> = {
  sender_not_allowed:
    "Der Absender steht nicht auf der Liste der erlaubten Absender. Die E-Mail wurde nicht verarbeitet. Wenn der Absender vertrauenswürdig ist, fügen Sie ihn unter E-Mail-Eingang hinzu und senden Sie die E-Mail erneut.",
  sender_not_authenticated:
    "Der Absender ist erlaubt, aber die E-Mail hat die Absenderprüfung (SPF, DKIM, DMARC) nicht bestanden. Die Absenderadresse könnte gefälscht sein, deshalb wurde die E-Mail nicht verarbeitet. Wenn sie echt ist, bitten Sie den Absender, sie direkt von seinem eigenen Postfach erneut zu senden.",
  no_supported_attachment:
    "Die E-Mail enthielt keinen Anhang, den Digipost lesen kann (PDF, JPEG, PNG, CAMT.053, MT940, CSV oder TSV). Es wurde kein Dokument angelegt.",
  quota_exceeded:
    "Das Dokumentenkontingent Ihres Tarifs ist ausgeschöpft. Nicht importierte Anhänge können Sie nach einer Tariferweiterung erneut senden.",
};

export function mailIntakeNotificationSubject(reason: NotifiedReason): string {
  return SUBJECTS[reason];
}

export type MailIntakeNotificationEmailProps = {
  workspaceName: string;
  reason: NotifiedReason;
  fromAddress: string;
  subject: string | null;
  url: string;
};

function MailIntakeNotificationEmail({ workspaceName, reason, fromAddress, subject, url }: MailIntakeNotificationEmailProps) {
  return (
    <Html lang="de">
      <Head />
      <Preview>{SUBJECTS[reason]}</Preview>
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f4f5", padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "32px", maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", margin: "0 0 16px" }}>
            Digipost
          </Heading>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            Im E-Mail-Eingang von &quot;{workspaceName}&quot; ist eine E-Mail von {fromAddress}
            {subject ? ` mit dem Betreff "${subject}"` : ""} eingegangen.
          </Text>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>{EXPLANATIONS[reason]}</Text>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            Weitere E-Mails mit demselben Problem melden wir in den nächsten 24 Stunden nicht erneut; Sie sehen sie im Protokoll.
          </Text>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            <Link href={url} style={{ color: "#111827", fontWeight: 600 }}>
              Zum E-Mail-Eingang
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

export async function renderMailIntakeNotificationEmail(props: MailIntakeNotificationEmailProps): Promise<RenderedEmail> {
  return renderEmail(<MailIntakeNotificationEmail {...props} />);
}
