-- Source for the custom migration inserting the 10 global categories (architecture brief's
-- product decision 2, decisions/0015-documents-and-quotas.md). These are production
-- reference data every workspace shares (workspace_id is null - "global" category), so they
-- are inserted by a migration, not by src/persistence/seed.sql (which never runs against a
-- real environment, only local/test-stack). Turned into a real migration file by
-- `pnpm db:generate:custom categories` (src/persistence/README.md); never edit the generated
-- migration file directly, edit this source and regenerate instead.
--
-- Idempotent: `on conflict do nothing` against the `categories_workspace_key_key` unique
-- constraint (workspace_id, key), so re-running this migration (or a future environment that
-- somehow already has these rows) never duplicates or errors.
--
-- `name` holds the German display default (decisions/0013-german-ui-language.md); the UI
-- prefers `src/i18n/messages/de.json`'s `Categories.<key>` translation by `key` and falls
-- back to this column only if a key has no catalog entry yet.
insert into public.categories (workspace_id, key, name) values
  (null, 'invoice', 'Rechnung'),
  (null, 'reminder', 'Mahnung'),
  (null, 'authority', 'Behördenschreiben'),
  (null, 'tax', 'Steuer/Finanzamt'),
  (null, 'contract', 'Vertrag'),
  (null, 'insurance', 'Versicherung'),
  (null, 'bank', 'Bank/Finanzen'),
  (null, 'personnel', 'Personal/Lohn'),
  (null, 'advertising', 'Werbung'),
  (null, 'other', 'Sonstiges')
on conflict (workspace_id, key) do nothing;
