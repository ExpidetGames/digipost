// The magic-link sign-in mail (WEBAPP_TEMPLATE_SPEC.md §6.2 "src/platform/auth/server/emails/"):
// a React Email component, rendered to both an HTML and a plain-text part by
// `src/platform/mailer/server`'s `renderEmail`. Sent by `src/platform/auth/server/auth.ts`'s
// `sendMagicLink` over our own SMTP - no third-party mailer or webhook involved.
import "server-only";

import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";

import { renderEmail, type RenderedEmail } from "@/platform/mailer/server";

// German copy, hardcoded here rather than through next-intl (decisions/0013-german-ui-language.md):
// this template renders outside a request-scoped next-intl context (Better Auth's
// `sendMagicLink` callback), and German is the product's only UI language for launch.
export const MAGIC_LINK_EMAIL_SUBJECT = "Ihr Anmeldelink für Digipost";

export type MagicLinkEmailProps = {
  url: string;
  expiresInMinutes: number;
};

function MagicLinkEmail({ url, expiresInMinutes }: MagicLinkEmailProps) {
  const minutesLabel = `${expiresInMinutes} Minuten`;
  return (
    <Html lang="de">
      <Head />
      <Preview>Mit diesem Link bei Digipost anmelden</Preview>
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f4f5", padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "32px", maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", margin: "0 0 16px" }}>
            Digipost
          </Heading>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            Nutzen Sie die Schaltfläche unten, um sich anzumelden. Dieser Link ist {minutesLabel} gültig und kann
            nur einmal verwendet werden.
          </Text>
          <Button
            href={url}
            style={{
              backgroundColor: "#111827",
              color: "#ffffff",
              padding: "10px 20px",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
              marginTop: "8px",
            }}
          >
            Anmelden
          </Button>
          <Text style={{ fontSize: "12px", color: "#6b7280", marginTop: "24px" }}>
            Oder fügen Sie diesen Link in Ihren Browser ein:
            <br />
            {url}
          </Text>
          <Text style={{ fontSize: "12px", color: "#6b7280" }}>
            Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderMagicLinkEmail(props: MagicLinkEmailProps): Promise<RenderedEmail> {
  return renderEmail(<MagicLinkEmail {...props} />);
}
