// E-Mail-Eingang end to end (decisions/0075-email-intake.md): the page per role, and a signed
// `email.received` webhook against the running app with the fake provider
// (`INBOUND_MAIL_PROVIDER=fake` in the test stack: one generated PDF per mail, passing
// SPF/DKIM/DMARC), until the document shows up with "Per E-Mail von".
import { createTestUser, loginAs } from "./helpers/auth";
import { deleteUserById, uniqueEmail } from "./helpers/db";
import { expect, test } from "./helpers/fixtures";
import { documentIdsFromMail, signedWebhook, webhookSecret } from "./helpers/mail-intake";
import { addMemberToWorkspace } from "./helpers/workspace";

test("a member sees the address but none of the admin controls", async ({ browser, baseURL, adminUser }) => {
  const memberContext = await browser.newContext();
  const member = await createTestUser("mail-member", uniqueEmail("mail-member"));
  try {
    await addMemberToWorkspace(adminUser.workspace.id, member.id);
    await loginAs(memberContext, member, baseURL!);
    const page = await memberContext.newPage();

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "E-Mail-Eingang" }).click();
    await expect(page.getByRole("heading", { name: "E-Mail-Eingang", level: 1 })).toBeVisible();
    await expect(page.getByTestId("mail-intake-address")).toHaveText(/^post-[a-z2-9]{20}@/);
    await expect(page.getByRole("button", { name: "Kopieren" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Neue Adresse erzeugen" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Wer darf Dokumente senden?" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Empfangene E-Mails" })).toHaveCount(0);
  } finally {
    await memberContext.close();
    await deleteUserById(member.id);
  }
});

test("the admin replaces the address and switches the sender policy", { tag: "@smoke" }, async ({ page, adminUser }) => {
  void adminUser;
  await page.goto("/dashboard/email-intake");
  const address = page.getByTestId("mail-intake-address");
  const before = await address.textContent();
  expect(before).toMatch(/^post-[a-z2-9]{20}@/);

  await page.getByRole("button", { name: "Neue Adresse erzeugen" }).click();
  await page.getByRole("button", { name: "Ja, neue Adresse erzeugen" }).click();
  await expect(address).not.toHaveText(before!);
  await expect(address).toHaveText(/^post-[a-z2-9]{20}@/);

  const anyone = page.getByRole("radio", { name: /Jeder, der die Adresse kennt/ });
  await expect(page.getByRole("radio", { name: /Nur bestimmte Absender/ })).toBeChecked();
  // The choice shows at once and is saved by a Server Action in the background: wait for that
  // POST before reloading.
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/dashboard/email-intake"));
  await anyone.check();
  await saved;
  await expect(page.getByRole("heading", { name: "Erlaubte Absender" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("radio", { name: /Jeder, der die Adresse kennt/ })).toBeChecked();

  await page.getByRole("radio", { name: /Nur bestimmte Absender/ }).check();
  await page.getByLabel("Absender hinzufügen").fill("Lieferant.de");
  await page.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(page.getByText("lieferant.de", { exact: false }).first()).toBeVisible();
});

test("a signed webhook from a team member turns the attachment into a document", async ({ page, request, adminUser }) => {
  const secret = webhookSecret();
  test.skip(!secret, "RESEND_WEBHOOK_SECRET is not configured for this run");

  await page.goto("/dashboard/email-intake");
  const address = (await page.getByTestId("mail-intake-address").textContent())!.trim();

  const webhook = signedWebhook({ from: `Admin <${adminUser.email}>`, to: [address] }, secret!);
  const response = await request.post("/api/webhooks/resend", { data: webhook.body, headers: webhook.headers });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", accepted: 1 });

  // The route's `after()` runs the job right away.
  await expect.poll(() => documentIdsFromMail(adminUser.workspace.id, webhook.emailId), { timeout: 30_000 }).toHaveLength(1);
  const [documentId] = await documentIdsFromMail(adminUser.workspace.id, webhook.emailId);

  await page.reload();
  await expect(page.getByRole("cell", { name: adminUser.email.toLowerCase() })).toBeVisible();
  await expect(page.getByText("Importiert", { exact: true })).toBeVisible();

  await page.goto(`/dashboard/documents/${documentId}`);
  await expect(page.getByText("Per E-Mail von")).toBeVisible();

  // A mail to a foreign address on the same Resend account is acknowledged and dropped.
  const foreign = signedWebhook({ from: adminUser.email, to: ["jemand@example.de"] }, secret!);
  const dropped = await request.post("/api/webhooks/resend", { data: foreign.body, headers: foreign.headers });
  expect(await dropped.json()).toEqual({ status: "ok", accepted: 0 });
});
