import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names (`clsx`) and resolve conflicting Tailwind utility
 * classes in favor of the last one (`tailwind-merge`), e.g. `cn("px-2", "px-4")` ===
 * `"px-4"`. Used by every component under `src/shared/ui-primitives/ui/`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
