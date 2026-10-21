import { getRequestConfig } from "next-intl/server";

// Single locale, no locale routing (WEBAPP_TEMPLATE_SPEC.md §2.5): every UI string still
// goes through next-intl/i18n/messages/<locale>.json, so adding a second locale later is
// a routing change, not a rewrite of every component. German is the only UI language for
// launch (decisions/0013-german-ui-language.md): the product ships DACH-only, English
// comes later as a routing change, not a rewrite.
export const defaultLocale = "de";

export default getRequestConfig(async () => {
  const locale = defaultLocale;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
