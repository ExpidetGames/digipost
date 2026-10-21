import type { Metadata } from "next";
import { IBM_Plex_Sans, Newsreader } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";

import { publicEnv } from "@/platform/env";

import "./globals.css";

// decisions/0056-paper-brand.md: Newsreader carries every heading, IBM Plex Sans everything
// else. Self-hosted by next/font (no request to Google at runtime, no layout shift from a
// late webfont); `globals.css` maps both variables onto `--font-heading`/`--font-sans`.
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  return {
    // Resolves relative OG/Twitter image URLs (src/app/opengraph-image.tsx) to absolute ones;
    // `publicEnv.appUrl` (not `serverEnv()`) because this runs during static generation too
    // (WEBAPP_TEMPLATE_SPEC.md: a build must not need runtime secrets).
    metadataBase: publicEnv.appUrl ? new URL(publicEnv.appUrl) : undefined,
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const messages = await getMessages();

  return (
    // Light only, on purpose (decisions/0056-paper-brand.md): no `ThemeProvider`, nothing ever
    // sets `.dark`. The product never had a theme toggle, so dark mode only ever meant "this
    // visitor's OS is dark" against a palette nobody had designed for it.
    <html lang="de" className={`h-full antialiased ${newsreader.variable} ${plexSans.variable}`}>
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
