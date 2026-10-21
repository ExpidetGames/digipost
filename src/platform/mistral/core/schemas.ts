// Lenient Zod parsing of Mistral's own API responses (architecture brief's "Mistral OCR
// facts": "Parse the response with a lenient Zod schema (blocks may be null/missing: fall
// back to distributing markdown paragraphs down the page)"). Every field a real API could
// plausibly omit or send as `null` is optional/nullable here; a genuinely unparseable
// response (not even matching this loose a shape) is the only thing that becomes
// `ai_invalid_response`.
import { z } from "zod";

const ocrBlockSchema = z.object({
  type: z.string().optional().default("text"),
  top_left_x: z.number(),
  top_left_y: z.number(),
  bottom_right_x: z.number(),
  bottom_right_y: z.number(),
  content: z.string().optional().default(""),
});

const ocrDimensionsSchema = z.object({
  dpi: z.number().optional(),
  height: z.number(),
  width: z.number(),
});

const ocrPageSchema = z.object({
  index: z.number(),
  markdown: z.string().optional().default(""),
  dimensions: ocrDimensionsSchema.nullish(),
  blocks: z.array(ocrBlockSchema).nullish(),
});

export const mistralOcrResponseSchema = z.object({
  pages: z.array(ocrPageSchema).default([]),
  model: z.string().optional(),
});

export type MistralOcrResponse = z.infer<typeof mistralOcrResponseSchema>;

export const mistralChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

export type MistralChatResponse = z.infer<typeof mistralChatResponseSchema>;
