/**
 * Guards against the "code has no translation" class of bug found elsewhere in P6's
 * review: every code `RequestErrorCode`/`CallbackErrorCode` can hold must have a message
 * under `de.json`'s `Login.errors` namespace (`ui/login-form.tsx`'s `t(\`errors.${errorCode}\`)`).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { CALLBACK_ERROR_CODES, REQUEST_ERROR_CODES } from "../core/error-codes";

describe("Login.errors covers REQUEST_ERROR_CODES and CALLBACK_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Login.errors;

  it.each([...REQUEST_ERROR_CODES, ...CALLBACK_ERROR_CODES])("code %s resolves", (code) => {
    expect(typeof errors[code], `Login.errors.${code} is missing from de.json`).toBe("string");
  });
});
