// A tiny, valid PDF generated on the fly with `pdf-lib` (already a project dependency) -
// no binary fixture file to keep in sync. `tests/e2e/**` may import third-party packages
// freely (STRUCTURE.md's `e2e` rule only forbids resolving into this repository's own
// `src/app/`/`src/modules/`/`src/shared/`/`src/platform/`/`src/persistence/`, not npm
// packages).
import { PDFDocument } from "pdf-lib";

export async function createTestPdfBuffer(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 300]);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}
