// The real `OcrEngine` (architecture brief's "Mistral OCR facts"): `POST /v1/ocr`, the
// original PDF sent as a base64 `data:` URL (R2/MinIO objects are private, so Mistral is
// never handed a URL it could fetch itself), `include_blocks: true`. Implements
// `src/modules/documents/core/ports.ts`'s `OcrEngine` - this owner (`src/platform/mistral`)
// importing a module's port type is allowed by the direction matrix (platform may import
// modules, WEBAPP_TEMPLATE_SPEC.md §4).
import "server-only";

import type { OcrEngine, OcrResult } from "@/modules/documents";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { mistralOcrResponseSchema } from "../core/schemas";
import { mistralFetch, type MistralFetchConfig } from "./mistral-fetch";

export type MistralOcrEngineConfig = MistralFetchConfig & { model: string };

export function createMistralOcrEngine(config: MistralOcrEngineConfig): OcrEngine {
  return {
    async recognize({ pdfBytes }) {
      const dataUrl = `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`;

      const json = await mistralFetch(
        "/v1/ocr",
        {
          model: config.model,
          document: { type: "document_url", document_url: dataUrl },
          include_blocks: true,
        },
        config,
      );

      const parsed = mistralOcrResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral OCR response failed validation");
      }

      const result: OcrResult = {
        pages: parsed.data.pages.map((page) => ({
          index: page.index,
          markdown: page.markdown,
          dimensions: page.dimensions
            ? { width: page.dimensions.width, height: page.dimensions.height, dpi: page.dimensions.dpi ?? 200 }
            : null,
          blocks: page.blocks
            ? page.blocks.map((block) => ({
                type: block.type,
                topLeftX: block.top_left_x,
                topLeftY: block.top_left_y,
                bottomRightX: block.bottom_right_x,
                bottomRightY: block.bottom_right_y,
                content: block.content,
              }))
            : null,
        })),
      };
      return result;
    },
  };
}
