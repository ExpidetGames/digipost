"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * The workspace-scoped "kick" + poll (decisions/0016-processing-pipeline-and-ai.md,
 * requirement 2c): rendered by both the Posteingang (`/dashboard`) and a document's detail
 * page (`/dashboard/documents/[id]`) whenever the page shows at least one document in
 * `uploaded`/`processing`. On mount (and whenever it flips from inactive to active - e.g. a
 * newly uploaded document appears) it calls `kickAction` once (schedules `runDueJobs` for the
 * caller's own workspace via the server's `after()`, so local dev without a cron scheduler
 * self-heals), then polls `router.refresh()` every `intervalMs` until the server-rendered
 * props say there is nothing left to wait for (`active` becomes `false`), at which point
 * polling stops - never renders anything itself.
 */
export function ProcessingPoller({
  active,
  kickAction,
  intervalMs = 3000,
}: {
  active: boolean;
  kickAction: () => Promise<void>;
  intervalMs?: number;
}) {
  const router = useRouter();
  const hasKickedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      hasKickedRef.current = false;
      return;
    }

    if (!hasKickedRef.current) {
      hasKickedRef.current = true;
      void kickAction();
    }

    const interval = setInterval(() => {
      router.refresh();
    }, intervalMs);

    return () => clearInterval(interval);
  }, [active, intervalMs, kickAction, router]);

  return null;
}
