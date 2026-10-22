// View shapes shared by the use case (`src/persistence/use-cases/mail-intake-use-cases.ts`), the
// read models (`server/read-models.ts`) and the client UI. Plain serializable data only, so a
// Server Component can hand them to a client island unchanged.
import type { AttachmentResult, InboundEmailReason, InboundEmailStatus } from "./inbound-email";
import type { AllowedSenderKind, SenderPolicy } from "./sender-policy";

export type AllowedSenderView = { id: string; kind: AllowedSenderKind; value: string };

export type MailIntakeSettingsView = {
  /** `null` when the deployment has no `INBOUND_EMAIL_DOMAIN` (the feature is off). */
  address: string | null;
  enabled: boolean;
  senderPolicy: SenderPolicy;
  allowedSenders: AllowedSenderView[];
  /** ISO timestamp of the last "Neue Adresse erzeugen", or `null`. */
  tokenRotatedAt: string | null;
};

export type InboundEmailView = {
  id: string;
  fromAddress: string;
  subject: string | null;
  /** ISO timestamp. */
  receivedAt: string;
  status: InboundEmailStatus;
  reasonCode: InboundEmailReason | null;
  attachments: AttachmentResult[];
};
