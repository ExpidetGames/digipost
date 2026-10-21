// Unit test for the render helper (WEBAPP_TEMPLATE_SPEC.md §10.2): no DB, no
// network, no env - `renderEmail` only turns a React element into HTML + text.
import { describe, expect, it } from "vitest";

import { renderEmail } from "@/platform/mailer/server/render-email";

function Greeting({ name }: { name: string }) {
  return <p>Hello, {name}!</p>;
}

describe("renderEmail", () => {
  it("renders both an html and a text part containing the element's content", async () => {
    const result = await renderEmail(<Greeting name="Ada" />);

    // React server-rendering inserts comment markers between interpolated
    // expressions (e.g. `Hello, <!-- -->Ada<!-- -->!`), so match loosely rather
    // than asserting on an exact contiguous substring.
    expect(result.html).toMatch(/Hello,\s*(?:<!--[^>]*-->)?\s*Ada/);
    expect(result.html).toMatch(/<p/);
    expect(result.text.trim()).toBe("Hello, Ada!");
  });
});
