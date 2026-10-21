import { describe, expect, it } from "vitest";

import { createFakeMailer } from "./support/fake-mailer";

describe("createFakeMailer", () => {
  it("collects every message sent through it, in order", async () => {
    const { mailer, sent } = createFakeMailer();

    await mailer.send({ to: "a@example.com", subject: "First", text: "1", html: "<p>1</p>" });
    await mailer.send({ to: "b@example.com", subject: "Second", text: "2", html: "<p>2</p>" });

    expect(sent).toEqual([
      { to: "a@example.com", subject: "First", text: "1", html: "<p>1</p>" },
      { to: "b@example.com", subject: "Second", text: "2", html: "<p>2</p>" },
    ]);
  });
});
