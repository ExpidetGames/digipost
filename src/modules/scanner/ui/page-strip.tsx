"use client";

// The multi-page thumbnail strip (product requirement 4): reorder (move left/right), delete,
// retake, and an "Seite hinzufügen" affordance disabled once `MAX_SCANNER_PAGES` is reached.
// Thumbnails apply the page's rotation/filter live via CSS (`FILTER_CSS`, the same string
// baked into the final upload encode, see `canvas-pipeline.ts`), so what is shown here is
// exactly what will be uploaded.
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { MAX_SCANNER_PAGES } from "../core/limits";
import type { ScannerPage } from "../core/types";
import { FILTER_CSS } from "./canvas-pipeline";

export interface PageStripProps {
  pages: ScannerPage[];
  onMoveLeft: (id: string) => void;
  onMoveRight: (id: string) => void;
  onRemove: (id: string) => void;
  onRetake: (id: string) => void;
  onAddPage: () => void;
}

export function PageStrip({ pages, onMoveLeft, onMoveRight, onRemove, onRetake, onAddPage }: PageStripProps) {
  const t = useTranslations("Scanner.pageStrip");
  const atMax = pages.length >= MAX_SCANNER_PAGES;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex gap-3 overflow-x-auto pb-2" aria-label={t("listLabel")}>
        {pages.map((page, index) => (
          <li key={page.id} className="flex w-28 shrink-0 flex-col gap-1 rounded-md border border-border p-2">
            <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- object URL, not a static/remote asset Next's image optimizer can handle */}
              <img
                src={page.previewUrl}
                alt={t("pageAlt", { number: index + 1 })}
                className="h-full w-full object-contain"
                style={{
                  transform: `rotate(${page.rotation}deg)`,
                  filter: FILTER_CSS[page.filter],
                }}
              />
            </div>
            <span className="text-center text-xs text-muted-foreground">{index + 1}</span>
            <div className="grid grid-cols-2 gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t("moveLeft")}
                disabled={index === 0}
                onClick={() => onMoveLeft(page.id)}
              >
                ←
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t("moveRight")}
                disabled={index === pages.length - 1}
                onClick={() => onMoveRight(page.id)}
              >
                →
              </Button>
              <Button type="button" variant="outline" size="sm" className="col-span-2" onClick={() => onRetake(page.id)}>
                {t("retake")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="col-span-2"
                aria-label={t("remove")}
                onClick={() => onRemove(page.id)}
              >
                {t("remove")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button type="button" variant="outline" disabled={atMax} onClick={onAddPage}>
        {atMax ? t("maxPagesReached") : t("addPage")}
      </Button>
    </div>
  );
}
