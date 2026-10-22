// Server Action input schemas (`actions.ts`). The workspace is never part of any input: it is
// always the caller's own, resolved by `requirePermission` (AGENTS.md "Workspace scoping").
import { z } from "zod";

import { SENDER_POLICIES } from "./sender-policy";

export const setMailIntakeEnabledInputSchema = z.object({ enabled: z.boolean() });
export const setSenderPolicyInputSchema = z.object({ policy: z.enum(SENDER_POLICIES) });
export const addAllowedSenderInputSchema = z.object({ value: z.string().trim().min(1).max(254) });
export const removeAllowedSenderInputSchema = z.object({ id: z.uuid() });
