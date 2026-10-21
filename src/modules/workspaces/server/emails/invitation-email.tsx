// The workspace invitation mail (this owner's own template, WEBAPP_TEMPLATE_SPEC.md's
// "Mandanten" recipe: "Einladungen per Magic Link"; STRUCTURE.md's `vendor-sdk` rule
// confines `@react-email/` to `src/platform/auth/server/emails/`, `src/platform/mailer/`,
// and this directory). A React Email component, rendered to both an HTML and a plain-text
// part by `src/platform/mailer/server`'s `renderEmail`, sent by `actions.ts`'s
// `inviteMemberAction` over our own SMTP - no third-party mailer or webhook involved.
import "server-only";

import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";

import { renderEmail, type RenderedEmail } from "@/platform/mailer/server";

// German copy, hardcoded here rather than through next-intl (decisions/0013-german-ui-language.md):
// this template renders outside a request-scoped next-intl context (a Server Action, not a
// rendered page), and German is the product's only UI language for launch.
export const INVITATION_EMAIL_SUBJECT = "Einladung zu Digipost";

export type InvitationEmailProps = {
  workspaceName: string;
  inviterEmail: string;
  url: string;
};

function InvitationEmail({ workspaceName, inviterEmail, url }: InvitationEmailProps) {
  return (
    <Html lang="de">
      <Head />
      <Preview>{`Sie wurden zu "${workspaceName}" bei Digipost eingeladen`}</Preview>
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f4f4f5", padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: "8px", padding: "32px", maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", margin: "0 0 16px" }}>
            Digipost
          </Heading>
          <Text style={{ fontSize: "14px", lineHeight: "1.6" }}>
            {inviterEmail} hat Sie eingeladen, dem Arbeitsbereich &quot;{workspaceName}&quot; bei Digipost
            beizutreten.
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
            Einladung annehmen
          </Button>
          <Text style={{ fontSize: "12px", color: "#6b7280", marginTop: "24px" }}>
            Oder fügen Sie diesen Link in Ihren Browser ein:
            <br />
            {url}
          </Text>
          <Text style={{ fontSize: "12px", color: "#6b7280" }}>
            Diese Einladung ist 7 Tage gültig. Falls Sie dies nicht erwartet haben, können Sie diese E-Mail
            ignorieren.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderInvitationEmail(props: InvitationEmailProps): Promise<RenderedEmail> {
  return renderEmail(<InvitationEmail {...props} />);
}
