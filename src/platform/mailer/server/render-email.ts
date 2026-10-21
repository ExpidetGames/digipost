// Render helper around `@react-email/render` (WEBAPP_TEMPLATE_SPEC.md §2.6): every
// mail template is a React Email component, rendered to both an HTML and a
// plain-text part.
import "server-only";

import type { ReactElement } from "react";
import { render } from "@react-email/render";

export type RenderedEmail = { html: string; text: string };

export async function renderEmail(element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
