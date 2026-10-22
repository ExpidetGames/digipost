"use server";

// The E-Mail-Eingang's admin actions (decisions/0075-email-intake.md). Every one needs
// `mail_intake.manage` (admin-only) and acts on the caller's own resolved workspace, never on
// an id from the client.
import { revalidatePath } from "next/cache";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { MAIL_INTAKE_ERROR } from "@/persistence/use-cases/mail-intake-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { ActionResult } from "@/shared/action-result";

import type { MailIntakeActionErrorCode } from "./core/error-codes";
import {
  addAllowedSenderInputSchema,
  removeAllowedSenderInputSchema,
  setMailIntakeEnabledInputSchema,
  setSenderPolicyInputSchema,
} from "./core/schemas";

const PAGE_PATH = "/dashboard/email-intake";

function mapUseCaseError(err: unknown): MailIntakeActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === MAIL_INTAKE_ERROR.notFound ||
      code === MAIL_INTAKE_ERROR.invalidSenderEntry ||
      code === MAIL_INTAKE_ERROR.senderAlreadyAllowed ||
      code === MAIL_INTAKE_ERROR.tooManyAllowedSenders
    ) {
      return code;
    }
  }
  console.error("[mail-intake] action failed", err instanceof Error ? err.name : "unknown");
  return "unknown";
}

/** "Neue Adresse erzeugen": the old address stops working immediately. */
export async function regenerateInboundAddressAction(): Promise<ActionResult<undefined, MailIntakeActionErrorCode>> {
  const access = await requirePermission(PERMISSIONS.mailIntakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().mailIntake.regenerateAddress(access.access.workspace.id);
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
  revalidatePath(PAGE_PATH);
  return { status: "success", data: undefined };
}

export async function setMailIntakeEnabledAction(input: unknown): Promise<ActionResult<undefined, MailIntakeActionErrorCode>> {
  const parsed = setMailIntakeEnabledInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.mailIntakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().mailIntake.setEnabled(access.access.workspace.id, parsed.data.enabled);
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
  revalidatePath(PAGE_PATH);
  return { status: "success", data: undefined };
}

export async function setSenderPolicyAction(input: unknown): Promise<ActionResult<undefined, MailIntakeActionErrorCode>> {
  const parsed = setSenderPolicyInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.mailIntakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().mailIntake.setSenderPolicy(access.access.workspace.id, parsed.data.policy);
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
  revalidatePath(PAGE_PATH);
  return { status: "success", data: undefined };
}

export async function addAllowedSenderAction(input: unknown): Promise<ActionResult<undefined, MailIntakeActionErrorCode>> {
  const parsed = addAllowedSenderInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_sender_entry" };
  const access = await requirePermission(PERMISSIONS.mailIntakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().mailIntake.addAllowedSender({
      workspaceId: access.access.workspace.id,
      value: parsed.data.value,
      userId: access.access.user.id,
    });
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
  revalidatePath(PAGE_PATH);
  return { status: "success", data: undefined };
}

export async function removeAllowedSenderAction(input: unknown): Promise<ActionResult<undefined, MailIntakeActionErrorCode>> {
  const parsed = removeAllowedSenderInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.mailIntakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().mailIntake.removeAllowedSender(access.access.workspace.id, parsed.data.id);
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
  revalidatePath(PAGE_PATH);
  return { status: "success", data: undefined };
}
