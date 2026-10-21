import { ImageResponse } from "next/og";

// Statically generated OG image (WEBAPP_TEMPLATE_SPEC.md §3): plain text, no external image
// asset, no external font (keeps this build-time-cacheable and dependency-free). Colors are
// the same `--background`/`--foreground`/`--muted-foreground`/`--brand-warm` values as
// `src/app/globals.css` (an OG image has no CSS context of its own, so the hex values are
// duplicated here on purpose, not read from a shared constant) - keep them in step by hand
// whenever the palette changes (decisions/0056-paper-brand.md). No serif either: loading
// Newsreader here would mean an external font fetch at build time, so the wordmark uses the
// default weight and the rust rule below carries the brand instead.
export const alt = "Digipost, digitaler Posteingang für KMU";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "#fafaf8",
          color: "#1c1e22",
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 600 }}>Digipost</div>
        <div style={{ width: 96, height: 3, marginTop: 28, background: "#a8481e" }} />
        <div style={{ marginTop: 28, fontSize: 30, color: "#5c5f66" }}>Digitaler Posteingang für kleine und mittlere Unternehmen</div>
      </div>
    ),
    { ...size },
  );
}
