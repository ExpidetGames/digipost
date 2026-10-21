# Webapp-Template: Tech Stack und Projektaufbau

Document type: explanation + reference
Lifecycle: proposed
Owner: maintainer
Scope: Konsolidiertes Startprojekt für neue Next.js-Webapps, abgeleitet aus Tablepay (`apps/reserwirt-web`) und Deeplify
Last verified: 2026-09-13 gegen Tablepay (`STRUCTURE.md`, `persistence/`, `platform/api-pipeline`, `modules/products`, Frontend-CI) und Deeplify (`lib/auth`, `lib/db`, `proxy.ts`, `tests/`, `scripts/`, CI)
Revision: 2 (2026-09-13): Schema eine Datei pro Owner (§5.7), Teststrategie mit Docker-Test-Stack, Unit-Regeln und E2E-Datenisolation (§10), CI-Pipeline ohne Git-Hooks (§11)
Revision: 3 (2026-09-13): Deployment ausschließlich durch die CI pro Umgebung, migrate vor deploy, Expand/Contract, Deploy-Check, Rollback (§13); Migrations-Runner mit `--expect-host` (§5.7)
Revision: 4 (2026-09-14): Node-Version verbindlich aus `.nvmrc` für Hosting/CI/Docker, lokal per `engines.node`-Bereich und optional fnm (§2.1, §16); Struktur-Checker realistisch mit ~1.600 Zeilen bewertet, Alternative über bestehende Import-Graph-Guard-Tests (§2.7, §11.5, §17); dritte DB-Rolle `app_public` für unauthentifizierte öffentliche Pfade (§5.8, §9, §13.3, §15, §16); Better-Auth-Rate-Limits gelten nur im eigenen Router, Server Actions rufen `getAuth().handler()` (§6.3, §10.4); Docker-Test-Stack mit C-Collation, initdb-Rollen und nicht-superuser Migrations-Owner, Migrate-Job seedet immer mit (§10.3); E2E-Session-Helfer setzt beide Cookie-Varianten (§10.4)
Revision: 5 (2026-09-15): Erfahrungen aus der vollständigen Deeplify-Migration (§18) - Agent-Aufträge müssen Doku-Orte konkret nennen (§12), Docker-Ressourcenbudget und ein Hang-Workaround für parallele Worktree-Agenten (§10.3), Hintergrund-Subagenten laufen nie zuverlässig weiter (§17), der Struktur-Checker läuft mit `tsx` und prüft `roots` nur gegen von Git verfolgte Pfade (§2.7/§11.5), `rawServerEnv()` als injizierbarer Default ohne eigene Zod-Validierung (§9), die produktive Rollen-/Schema-Umstellung läuft über eine frische Datenbank statt In-Place-Migration (§13.2), der Vercel-Commit-Autor-Block erzwingt `git archive`-Deploys ohne `.git` (§13.6), Erfahrungen beim vollständigen Retirement einer pgTAP-Suite zugunsten von Vitest-Integrationstests (§10), Staging als Vercel-Preview-Deployment plus stabilem Alias statt eigener Umgebung (§13.1), `workflow_run` braucht einen `push`-Trigger auf dem Ziel-Branch, sonst löst ein Merge nie einen Deploy aus (§11.3), und `vercel env pull` liefert nicht jeden als "sensitive" markierten Wert zurück (§13)
Revision: 6 (2026-09-19): Repository-Layout mit `src/` für den gesamten Anwendungscode (Owner-Wurzeln, `proxy.ts`, `instrumentation*.ts`, Sentry-Configs; `@/` zeigt auf `src/`), einer `tests/`-Wurzel nur für owner-übergreifende Suites (`tests/e2e/`, `tests/integration/`, `tests/config/`) statt getrennter `e2e/`- und `integration-tests/`-Wurzeln, Compose-Dateien in `docker/` mit `--project-directory` auf die Repo-Wurzel, `roots`-Regel prüft `src/` und `tests/` als governed roots (§3, §10, §11.5); Pfade in §18 bleiben im alten Layout, weil sie die Deeplify-Migration historisch beschreiben

---

## 0. Kurzfassung

Das Template übernimmt von **Tablepay** die Struktur und die Regeln (Owner-Modell `modules/` · `shared/` · `platform/` · `persistence/`, maschinell geprüfte `STRUCTURE.md`, Repositories + Use Cases + Composition Root, Fehlercodes, Doku-Governance), von **Deeplify** die Auth und die Sicherheitsmechanik (Better Auth selbst gehostet, Proxy nur mit Cookie-Präsenz, Least-Privilege-DB-Rollen, Guard-Tests, Migrations-Runner mit Produktionsschutz, Mailpit, Playwright mit echtem Magic Link) und ersetzt alles Anbieterspezifische durch **Standard-Postgres über TCP + Drizzle**.

| Bereich | Entscheidung | Herkunft |
|---|---|---|
| Framework | Next.js 16 (App Router, `proxy.ts`), React 19, TypeScript strict | beide |
| Paketmanager | pnpm; Node-Major-Version aus `.nvmrc` bindend für Hosting/CI/Docker-Images, `engines.node` als Bereich (z. B. `">=24"`), lokale Parität optional über fnm | Deeplify |
| Datenbank | PostgreSQL (≥ 16, lokal 18), **kein** Anbieter-SDK im App-Code | neu |
| DB-Treiber | `pg` (node-postgres) mit Pool, ein Treiber für Runtime, Migrationen und Tests | neu (Deeplify nutzt `pg` bereits für Migrationen) |
| ORM / Migrationen | Drizzle ORM + drizzle-kit (`generate`, nie handgeschrieben); Schema zentral, eine Datei pro Owner | Tablepay, verfeinert |
| DB-Zugriffsmuster | Repository-Contracts → Drizzle-Repositories → Use Cases → Composition Root | Tablepay, verbessert |
| Auth | Better Auth 1.7, Drizzle-Adapter, Magic Link, DB-Rate-Limit, gehashte Tokens | Deeplify |
| Autorisierung | eigene Tabellen + Rollen→Rechte-Bündel (`as const`), nie im Auth-Framework | Tablepay |
| UI | Tailwind 4, shadcn/ui, lucide, sonner, next-themes | beide |
| Validierung / Forms | Zod 4 an jeder Grenze, react-hook-form nur für komplexe Client-Formulare | Tablepay |
| i18n | next-intl (zunächst ohne Locale-Routing) | Tablepay |
| Mail | nodemailer über SMTP (anbieterneutral), React Email für Vorlagen, Mailpit lokal | Deeplify + Tablepay |
| Datei-Speicher | S3-kompatibel (`@aws-sdk/client-s3`), lokal MinIO, als Rezept | neu (ersetzt Supabase Storage) |
| Jobs / Cron | Vercel Cron + `CRON_SECRET` + DB-Jobtabelle (`for update skip locked`) | beide |
| Observability | Sentry (Fehler), PostHog EU mit Consent (Produktanalyse, optional) | Tablepay + Deeplify |
| Tests | Vitest (unit / db / integration), Playwright (E2E), Struktur-Checker | beide |
| Lokale Infrastruktur | `docker/compose.yml` für die Entwicklung (Postgres 18, Mailpit), `docker/compose.test.yml` als hermetischer Test-Stack (DB, Mailpit, App-Build, Playwright) | neu |
| CI | GitHub Actions; DB- und E2E-Tests laufen im selben Docker-Test-Stack wie lokal | neu |
| Git-Hooks | keine; `pnpm verify` vor jedem PR ist Regel, die CI ist das einzige Tor | neu |
| Hosting | Vercel (Functions-Region nah an der DB) | beide |

**Leitsatz:** Anbieterunabhängig heißt *Postgres-Anbieter-unabhängig*, nicht *Datenbank-unabhängig*. Wir nutzen bewusst Postgres-Features (`jsonb`, `for update skip locked`, Advisory Locks, Rollen, optional RLS). Neon, Supabase-Postgres, RDS, Hetzner oder ein lokaler Container sind austauschbar, indem nur zwei Connection-Strings wechseln.

---

## 1. Ziele und Nicht-Ziele

**Ziele**

1. Ein neues Projekt startet mit lauffähigem Login, einem Beispielmodul (vertikaler Schnitt durch alle Schichten), grüner CI und geprüfter Struktur.
2. Der DB-Anbieter ist eine Konfigurationsfrage: `DATABASE_URL` + `DATABASE_URL_MIGRATE`. Kein `@supabase/*`, kein `@neondatabase/*` im Anwendungscode.
3. Auth liegt vollständig bei uns (Code, Tabellen, Mails). Kein externer Auth-Dienst.
4. Architekturregeln werden **maschinell** durchgesetzt (Struktur-Checker, ESLint, Guard-Tests, CI), nicht nur dokumentiert.
5. Tests laufen auf jedem Gerät und in der CI identisch (Docker-Test-Stack).
6. Schneller Entwicklungsfluss: PR-Rückmeldung in ~5–6 Minuten, keine lokalen Wartezeiten durch Hooks.
7. Mehrere KI-Agenten können parallel im Repo arbeiten, ohne sich Arbeit zu zerstören.

**Nicht-Ziele**

- Unterstützung anderer DB-Engines (MySQL, SQLite).
- Ein Monorepo von Beginn an. Ein zweites Deployable (z. B. getrennte Marketing-Site, Mobile-API) kommt erst, wenn es gebraucht wird (siehe §16).
- Fachliche Features wie Payments, PDF, Push. Die kommen als **Rezepte** (§14), nicht als Template-Code.

---

## 2. Tech Stack im Detail

Versionen = aktueller Stand der beiden Projekte; beim Anlegen des Templates auf die jeweils neueste Minor-Version heben und exakt pinnen.

### 2.1 Laufzeit und Framework

| Paket | Version | Zweck / Regel |
|---|---|---|
| `next` | 16.3.x | App Router, Turbopack, `proxy.ts`. Vor Nutzung einer Next-API `node_modules/next/dist/docs/` lesen |
| `react`, `react-dom` | 19.2.x | Server Components zuerst |
| `typescript` | 5.x | `strict`, kein `any` ohne Kommentar |
| `server-only` | 0.0.1 | Marker für privilegierte Dateien, Senke im Client-Erreichbarkeits-Graph |
| `@vercel/functions` | 3.x | `attachDatabasePool` (Pool-Hygiene bei Fluid Compute), `waitUntil` |
| Node | 24 LTS | maßgeblich sind Hosting, CI und Docker-Images: exakt dieselbe Major-Version, aus `.nvmrc` gelesen |

Maßgeblich für die Node-Version sind Hosting (Vercel-Projekteinstellung), CI und die Docker-Images, alle auf derselben Major-Version aus `.nvmrc`. Auf Entwicklungsmaschinen darf eine neuere Node-Version laufen: `engines.node` in `package.json` ist ein Bereich (z. B. `">=24"`), sodass eine neuere lokale Node-Version funktioniert; lokale Parität mit `.nvmrc` ist optional über fnm (liest `.nvmrc`). Ein Upgrade auf die nächste LTS-Version geschieht immer gemeinsam (Hosting-Einstellung, Dockerfiles, `.nvmrc`) in einem Commit, erst sobald die Version LTS und vom Hosting unterstützt ist.

### 2.2 Daten

| Paket | Version | Zweck / Regel |
|---|---|---|
| `pg` + `@types/pg` | 8.x | einziger DB-Treiber, Pool pro Prozess |
| `drizzle-orm` | 0.45.x | Query Builder + Typen, `casing: "snake_case"` |
| `drizzle-kit` | 0.31.x | `generate` (Migrationen aus Schema), `studio`. Kein `push` gegen geteilte DBs |

Warum `pg` statt `postgres` (Tablepay) oder `@neondatabase/serverless` (Deeplify):

- Funktioniert unverändert mit Neon, Supabase (Supavisor), RDS, PgBouncer im Transaction-Mode (keine benannten Prepared Statements, kein `prepare: false`-Sonderfall).
- Better Auth, drizzle-kit, der Migrations-Runner und die Tests sprechen denselben Treiber.
- Der Neon-HTTP-Treiber bleibt eine **Option für einzelne heiße Pfade**, dann aber ausschließlich in `src/persistence/foundation/client.ts` gekapselt (austauschbarer Adapter, siehe §5.9).

### 2.3 Auth

| Paket | Version | Zweck |
|---|---|---|
| `better-auth` | 1.7.x | Identität, Session, Magic Link, Rate-Limit, Drizzle-Adapter (`better-auth/adapters/drizzle`) |

### 2.4 UI

| Paket | Zweck / Regel |
|---|---|
| `tailwindcss` 4 + `@tailwindcss/postcss`, `tw-animate-css` | Styling über semantische Tokens (CSS-Variablen), nie Farben hart im Code |
| `shadcn` (CLI) + Primitive-Bibliothek | Komponenten liegen in `src/shared/ui-primitives/`. Primitive einmal festlegen (Deeplify: Base UI, Tablepay: Radix) |
| `class-variance-authority`, `clsx`, `tailwind-merge` | `cn()` in `src/shared/ui-primitives/core/cn.ts` |
| `lucide-react` | Icons |
| `sonner` | Toasts |
| `next-themes` | Light/Dark |

### 2.5 Validierung, Formulare, i18n

| Paket | Zweck / Regel |
|---|---|
| `zod` 4 | Jede Grenze (Action-Input, Route-Body, Env, externe Antworten) wird geparst |
| `react-hook-form` + `@hookform/resolvers` | nur für komplexe Client-Formulare; einfache Formulare = Server Action + `useActionState` |
| `next-intl` 4 | Alle UI-Texte aus `src/i18n/messages/<locale>.json`. Start **ohne** Locale-Routing (eine Sprache), Routing wird aktiviert, sobald eine zweite Sprache kommt |

### 2.6 Mail, Storage, Jobs, Observability

| Paket | Zweck | Status |
|---|---|---|
| `nodemailer` | SMTP-Transport (Resend, Postmark, SES, Mailgun sprechen alle SMTP) | Template |
| `@react-email/components` + `@react-email/render` | Mail-Vorlagen als React, Text- und HTML-Variante | Template |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | S3-kompatibler Speicher (R2, S3, Hetzner, MinIO) | Rezept |
| `@sentry/nextjs` | Fehler + Performance | Template (per Env abschaltbar) |
| `posthog-js` / `posthog-node` + `klaro` | Produktanalyse über `/ingest`-Proxy, cookielos bis Consent | Rezept |

### 2.7 Test und Tooling

| Paket / Werkzeug | Zweck |
|---|---|
| `vitest` + `@vitest/coverage-v8` | Projekte `unit`, `db`, `integration` |
| `@testing-library/react` + `jsdom` | Komponententests (Datei-Direktive `// @vitest-environment jsdom`) |
| `@playwright/test` | E2E inkl. Magic-Link-Login über Mailpit |
| Docker + Docker Compose | Entwicklungsdienste (`docker/compose.yml`) und hermetischer Test-Stack (`docker/compose.test.yml`); Playwright-Image `mcr.microsoft.com/playwright:v<Version>-noble` exakt passend zu `@playwright/test` |
| `eslint` 9 + `eslint-config-next` | Flat Config + Import-Grenzen |
| Struktur-Checker (eigener Code, ~1.600 Zeilen, aus Tablepay portiert; substanzielle Portierungsarbeit) | liest `STRUCTURE.md`, prüft Wurzeln, Entrypoints, Abhängigkeitsrichtung, Persistence-Schichten, Tests, Doku |

Der Checker ist kein Wochenendprojekt. Projekte, die bereits Import-Graph-Guard-Tests besitzen, bauen die Regeln stattdessen auf diesem vorhandenen Modul-Graph-Code auf, statt den Checker vollständig zu kopieren (§11.5, §17).

### 2.8 Bewusst **nicht** im Template

| Weggelassen | Grund / Ersatz |
|---|---|
| `@supabase/supabase-js`, `@supabase/ssr`, Supabase CLI, `supabase/`-Ordner | Anbieterbindung; ersetzt durch Drizzle + Better Auth + S3-Rezept + Docker-Postgres |
| `@neondatabase/serverless` im App-Code | Anbieterbindung; nur als optionaler Treiber-Adapter in `foundation/` |
| Neon Auth, Rohes-SQL-`withUser`-Muster, Kysely | ersetzt durch Drizzle-Adapter + Unit of Work (RLS als Option, §5.8) |
| Tablepays `dashboard-data-cache` | projektspezifischer Client-Store; im Template reichen RSC + `revalidatePath` |
| Eager-Barrel `src/persistence/index.ts`, Transitional-Exceptions | Altlasten, von Anfang an vermeiden |
| Git-Hooks (husky, lefthook, lint-staged) | parallele Agenten im selben Arbeitsverzeichnis: Hooks testen fremde halbfertige Änderungen mit, lint-staged nutzt `git stash` (§11.2) |
| Preview-Deploys pro PR | bräuchten eine eigene DB mit den PR-Migrationen (praktisch nur per Anbieter-Branching); PRs prüft der Test-Stack, Staging ist die gemeinsame Vorschau (§13.6) |
| Stripe, React-PDF, QR, FCM-Push | Rezepte (§14) |
| `.env.production(.local)`, `.env.test` | Next lädt `.env.production` bei jedem lokalen Build → lokale Builds träfen Produktion (Deeplify-Lehre); Test-Env steht in `docker/compose.test.yml` |

---

## 3. Repository-Layout

Die Wurzel enthält nur drei Arten von Einträgen: Anwendungscode unter `src/` (offiziell unterstützter Next.js-`src`-Ordner), owner-übergreifende Test-Suites unter `tests/` und alles, was Werkzeuge an der Wurzel erwarten (Konfiguration, `public/`, Governance-Dokumente), dazu `docker/` und `scripts/`. Der `@/`-Alias zeigt auf `src/` (`@/modules/…`, `@/platform/…`).

```text
<project>/
├─ AGENTS.md                  verbindliche Agent-Regeln (auch für Claude)
├─ CLAUDE.md                  nur "@AGENTS.md" (+ der von `next dev` verwaltete Next-Block)
├─ README.md                  Einstieg: Zweck, Layout, Setup, Befehle, Env-Variablen
├─ STRUCTURE.md               Strukturpolitik + maschinenlesbare ```structure-Blöcke
├─ DOC_RULES.md               Doku-Governance (Metadaten, Typen, Lifecycle, ADR)
├─ decisions/                 anwendungsweite ADRs: NNNN-kurztitel.md
│
├─ src/                       gesamter Anwendungscode
│  ├─ app/                    NUR Next-Seams (page, layout, route, loading, error, …)
│  │  ├─ (marketing)/         statisch; liest nie Cookies/Session (bleibt prerendered)
│  │  ├─ (auth)/login/page.tsx   Seam → src/modules/sign-in
│  │  ├─ (app)/layout.tsx     validiert Session echt (getCurrentUser → redirect)
│  │  │  └─ dashboard/…       Seams → src/modules/<capability>
│  │  ├─ api/
│  │  │  ├─ auth/[...all]/route.ts     Better-Auth-Handler (delegiert an src/platform/auth)
│  │  │  ├─ health/route.ts            Healthcheck (Test-Stack, Deploy-Check, Monitoring)
│  │  │  ├─ cron/<job>/route.ts        Bearer CRON_SECRET, timing-safe
│  │  │  └─ webhooks/<provider>/route.ts
│  │  └─ layout.tsx · globals.css · robots.ts · sitemap.ts · opengraph-image.tsx
│  │
│  ├─ modules/<capability>/   fachliche Fähigkeit: UI, Actions, Read Models, Doku, Tests
│  ├─ shared/<purpose>/       neutraler Code mit ≥ 2 echten Konsumenten (z. B. ui-primitives, formatting)
│  ├─ platform/<concern>/     anwendungsweite Infrastruktur
│  │  ├─ env/                 Zod-validierte Env; einziger Leser von process.env
│  │  ├─ auth/                Better Auth, Session, Proxy-Cookie-Gate, Magic-Link-Mail
│  │  ├─ access/              Rollen → Rechte, requirePermission (sobald Mandanten existieren)
│  │  ├─ mailer/              SMTP-Transport + Render-Helfer (Port für Use Cases)
│  │  ├─ api-pipeline/        Route-Handler-Pipeline, {errorCode}-Envelope, Cron-Auth
│  │  └─ observability/       Sentry-Init (server/edge/client)
│  │
│  ├─ persistence/            EINE Wurzel mit geordneten Schichten (§5)
│  │  ├─ README.md
│  │  ├─ schema/              Drizzle-Schema, eine Datei pro Owner: index.ts (Barrel), auth.ts, <modul>.ts
│  │  ├─ migrations/          generiert von drizzle-kit, nie von Hand, eine Historie für alle Owner
│  │  ├─ sql/<name>/<name>.sql   Quellen für Custom-Migrationen (Funktionen, Trigger, Grants, Backfills)
│  │  ├─ foundation/          client.ts, db-types.ts, db-errors.ts
│  │  ├─ repositories/
│  │  │  ├─ contracts/        Interfaces + Zeilentypen + Repositories/UnitOfWork-Typen
│  │  │  └─ drizzle/          Implementierungen + create-repositories.ts + unit-of-work.ts
│  │  ├─ use-cases/           Fachlogik, errors.ts
│  │  ├─ composition/         create-request-services.ts, request-services.ts, auth-database.ts
│  │  ├─ seed/                Seed für lokal/Test-Stack (verweigert Nicht-lokal)
│  │  └─ tests/               Use-Case-Tests (Fakes), support/ (Fake-Repositories), *.db.test.ts
│  │
│  ├─ i18n/                   request.ts + messages/en.json (später de.json …)
│  └─ proxy.ts · instrumentation.ts · instrumentation-client.ts · sentry.server.config.ts · sentry.edge.config.ts
│
├─ tests/                     NUR owner-übergreifende Suites (Owner-Tests liegen im Owner-eigenen tests/)
│  ├─ e2e/                    Playwright-Specs + serial/ + helpers/ (Fixtures, Daten-Factories, Session, Mailpit)
│  ├─ integration/            http/ webhooks/ workflows/ compatibility/ support/
│  └─ config/                 Unit-Tests für Wurzel-Konfiguration (z. B. next.config.test.ts)
│
├─ scripts/                   structure/ (Checker), db/ (migrate, seed, reset, bootstrap-roles), test/ (docker.mjs, unit-guard.ts), deploy/ (check.mjs)
├─ docker/                    app.Dockerfile (deps → tools | build → runner), e2e.Dockerfile (Playwright-Image),
│                             compose.yml (Entwicklung: Postgres 18 + Mailpit, mit Host-Ports),
│                             compose.test.yml (hermetischer Test-Stack, eigener Projektname, keine Host-Ports)
├─ public/
│
├─ next.config.ts · drizzle.config.ts · vitest.config.ts · playwright.config.ts
├─ eslint.config.mjs · postcss.config.mjs · components.json · tsconfig.json
├─ vercel.json · .env.example · .nvmrc · package.json · pnpm-lock.yaml
└─ .github/workflows/ci.yml
```

`components/`, `lib/`, `server/`, `utils/`, `services/` und `docs/` existieren **nicht** und dürfen nicht entstehen, weder an der Wurzel noch direkt unter `src/` oder `tests/` (Checker-Regel `roots`: `src/` und `tests/` sind *governed roots*, jedes direkte Kind muss in `STRUCTURE.md` deklariert sein). `tests/` ist kein generischer Test-Sammelordner: Unit- und DB-Tests bleiben beim Owner.

Die Compose-Dateien liegen in `docker/`, werden aber immer mit `--project-directory` auf die Repo-Wurzel aufgerufen (`pnpm infra:up`/`infra:down`, `scripts/test/docker.mjs`): relative Pfade, Compose-Projektname (und damit der Name des lokalen Postgres-Volumes) und das `.env`-Lookup verhalten sich wie an der Wurzel. Ein nacktes `docker compose up` an der Wurzel funktioniert deshalb nicht.

Konfigurationsdateien bleiben an der Wurzel: Editor-Integrationen (Vitest-/Playwright-Extension, shadcn-CLI) und Next.js selbst erwarten sie dort. Ein Monorepo (`apps/`, `packages/`) lohnt erst ab einer zweiten App.

---

## 4. Strukturregeln (aus Tablepay, angepasst)

Die vollständige Politik steht im Template in `STRUCTURE.md`; der Checker `pnpm verify:structure` ist ein **Interpreter** der ```structure-Blöcke dieser Datei, keine zweite Kopie. Ein Block-Schlüsselwort ohne Implementierung und eine Implementierung ohne Block sind beide harte Fehler. Grenzen, die nicht prüfbar sind, stehen explizit unter „Enforcement Limits“.

### 4.1 Owner-Kategorien

| Kategorie | Besitzt | Aufnahmeregel |
|---|---|---|
| `src/modules/<capability>/` | eine fachliche Fähigkeit: UI, Server Actions, Read Models, Kern-Vokabular, Tests, README | Split, wenn Teile eigenes Vokabular, eigene Rechte oder eigene Änderungsgründe bekommen. Weder Akteur-Megamodule noch ein Modul pro Tabelle |
| `src/shared/<purpose>/` | neutraler Code | nur mit **≥ 2 real existierenden** Konsumenten (im README gezählt), importiert nie Module oder `src/app/` |
| `src/platform/<concern>/` | anwendungsweite Framework-/Provider-Infrastruktur | benannte Verantwortung, kein umbenanntes `lib/`; fachliche Provider-Logik bleibt im Modul |
| `src/persistence/` | Schema, Migrationen, Repositories, Use Cases, Composition Root | Schichtordnung + Seam-only-Entry (§5) |

### 4.2 Öffentliche Entrypoints je Owner

| Datei | Laufzeit | Regel |
|---|---|---|
| `index.ts` | neutral | erreicht weder Client- noch Server-only-Code |
| `client.ts` | Client | beginnt mit `"use client"`, erreicht nie privilegierten Code |
| `server.ts` | privilegiert | `import "server-only"`, nie aus client-erreichbarem Code importiert |
| `actions.ts` / `*-actions.ts` | Server Functions | top-level `"use server"`, exportiert nur async Funktionen + Typen, wird nie re-exportiert |
| weitere Subpaths | je nach Grund | nur mit Begründung im Owner-README **und** im Dateikopf (Beispiel: `src/platform/auth/proxy-gate.ts`) |

Owner-intern: `core/` (neutral), `ui/` (+ `ui/client/`), `server/`, `tests/`. Präzisere Namen (`workflows/`, `emails/`, `validation/`) sind erwünscht; `utils/`, `services/`, `data/`, `misc/` sind verboten. Keine leeren Ordner, keine leeren Entrypoints.

### 4.3 Abhängigkeitsmatrix (geschlossen)

```structure direction
may-import app                app:seam modules:public shared:public platform:public persistence:seam i18n
may-import modules            modules:public shared:public platform:public persistence:seam i18n
may-import shared             shared:public platform:public i18n
may-import platform           platform:public shared:public modules:neutral persistence:narrow i18n
may-import persistence        shared:public platform:public modules:neutral
may-import i18n               i18n
may-import root-config        modules:public shared:public platform:public persistence:seam i18n
may-import integration-tests  app modules:public shared:public platform:public persistence:seam i18n
may-import e2e                e2e
may-import scripts            nothing

forbid client-reachable-reaches-privileged
```

Abweichungen zu Tablepay: `shared` darf `persistence` nicht mehr erreichen (bleibt wirklich neutral); `platform` erreicht `persistence` nur über deklarierte **Narrow Entries** (z. B. die Auth-DB-Instanz); neue Kategorie `e2e` (spricht nur HTTP und direkt mit der Test-DB, importiert keinen App-Code).

### 4.4 Platzierungsentscheidung

1. Verlangt Next/ein Tool einen festen Pfad → Seam dort, Logik an den Owner delegieren.
2. Dient der Code primär einer Fähigkeit → `src/modules/<capability>/`.
3. Neutral und ≥ 2 unabhängige Konsumenten → `src/shared/<purpose>/` prüfen.
4. Anwendungsweite Infrastruktur → `src/platform/<concern>/`.
5. Unklar → weiter untersuchen. Nie „erstmal nach src/shared/platform“.

---

## 5. Persistence-Schicht

Das Herz des Templates. Tablepays Modell bleibt, mit vier gezielten Verbesserungen:

1. **Contracts getrennt von Drizzle.** Repository-Interfaces und der `Repositories`-Typ liegen in `repositories/contracts/`. Use Cases importieren nie aus `repositories/drizzle/` (bei Tablepay importieren Use Cases `RepositoryFactory` aus `drizzle-repository-factory.ts`).
2. **Die Unit of Work reicht Repositories statt Transaktions-Handles.** Use Cases sehen nie ein `tx`/`DbExecutor`; damit sind sie frei von Drizzle-Typen und trivial mit Fakes testbar.
3. **Flacheres Layout** (`src/persistence/foundation|repositories|use-cases|composition` statt Tablepays `persistence/runtime/...`), Migrationen unter `src/persistence/migrations/`.
4. **Schema eine Datei pro Owner** (`schema/projects.ts` statt grober Fachgebiets-Dateien wie `app_schema.ts`), mit der Regel „nur der Owner schreibt“ (§5.7).

### 5.1 Schichten und Ränge

```structure persistence-layers
foundation      # schema/, migrations/, sql/, foundation/
repositories    # repositories/contracts/, repositories/drizzle/
use-cases       # use-cases/
composition     # composition/
```

Eine Datei importiert ihren eigenen oder einen niedrigeren Rang, nie einen höheren.

```structure persistence-entry
composition/request-services.ts
composition/create-request-services.ts
repositories/contracts/
use-cases/
```

Alles andere ist intern (Client, Schema, Drizzle-Repositories, DB-Typen). Ausnahme nur als **Narrow Entry** mit Owner, Grund und exakter Importeur-Liste im `src/persistence/README.md`:

```structure narrow-entry
target   src/persistence/composition/auth-database.ts
owner    persistence
importer src/platform/auth/server/auth.ts
reason   Better Auth braucht die Drizzle-Instanz und das Auth-Schema für seinen Adapter; der Rest des Graphen (Use Cases, Mailer) gehört nicht in die Auth-Initialisierung.
```

Der Proxy importiert **gar nichts** aus `src/persistence/` (Tablepay-Lehre: der volle Graph landete sonst im Proxy-Bundle).

### 5.2 Foundation

**`foundation/client.ts`** (einziger Ort, der den Treiber kennt)

```ts
import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { serverEnv } from "@/platform/env/server";
import * as schema from "@/persistence/schema";

function createDb() {
  const pool = new Pool({
    connectionString: serverEnv().DATABASE_URL, // SSL über ?sslmode=require im String
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  attachDatabasePool(pool); // Vercel Fluid: idle Clients vor dem Suspend schließen
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type AppDb = ReturnType<typeof createDb>;

declare global {
  var __appDb: AppDb | undefined; // überlebt HMR in `next dev`
}

export function getDb(): AppDb {
  return (globalThis.__appDb ??= createDb());
}
```

**`foundation/db-types.ts`**: `DbExecutor = AppDb | DbTx`, `DbTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0]` (wie Tablepay).

**`foundation/db-errors.ts`** (Deeplifys SQLSTATE-Mapping, treiberneutral formuliert)

```ts
export type DbErrorKind =
  | "unique"          // 23505
  | "foreign_key"     // 23503
  | "check"           // 23514
  | "invalid_input"   // 22001, 23502, 22P02
  | "forbidden"       // 42501 (Grant/RLS)
  | "serialization"   // 40001, 40P01 → retry-fähig
  | "raised"          // P0001 aus eigenen SQL-Funktionen/Triggern
  | "unknown";

/** Neuere Drizzle-Versionen umhüllen Treiberfehler (`cause`), daher zentral auspacken. */
export function dbErrorOf(err: unknown): { kind: DbErrorKind; code: string | null; constraint: string | null; message: string } { … }
export function isDbError(err: unknown, kind: DbErrorKind): boolean { … }
```

### 5.3 Repositories

Regeln:

- Ein Repository kapselt **Zugriff**, keine Fachregeln. Keine Validierung, keine Statusübergänge, keine externen Aufrufe.
- Jede mandanten- oder besitzergebundene Methode nimmt die Scope-ID als Parameter und filtert darauf (`archive(id, ownerId)`), auch wenn der Use Case schon geprüft hat. Autorisierung ist dadurch nicht nur Konvention.
- Nicht gefunden → `null`, nicht werfen. DB-Fehler werden nicht verschluckt.
- Rückgabe: Zeilentypen/Projektionen aus `contracts/`; das Mapping auf UI-DTOs macht der Use Case bzw. das Read Model.
- Schreibende Methoden nur auf Tabellen des eigenen Owners (§5.7).

**Contract** `repositories/contracts/projects-repository.ts`

```ts
import type { InferSelectModel } from "drizzle-orm";
import type { projects } from "@/persistence/schema/projects"; // nur Typ-Import, erased zur Laufzeit

export type ProjectRow = InferSelectModel<typeof projects>;
export type CreateProjectRow = { ownerId: string; name: string };

export interface ProjectRepository {
  listActiveByOwner(ownerId: string): Promise<ProjectRow[]>;
  create(input: CreateProjectRow): Promise<ProjectRow>;
  archive(id: string, ownerId: string): Promise<ProjectRow | null>;
}
```

**Contract** `repositories/contracts/index.ts`

```ts
export type Repositories = {
  project: ProjectRepository;
  // … ein Eintrag pro Repository
};

export interface UnitOfWork {
  /** Führt `work` in genau einer Transaktion aus; die übergebenen Repositories sind an sie gebunden. */
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
```

**Implementierung** `repositories/drizzle/projects-repository.ts`

```ts
import { and, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/persistence/foundation/db-types";
import { projects } from "@/persistence/schema/projects";
import type { ProjectRepository } from "@/persistence/repositories/contracts/projects-repository";

export function createDrizzleProjectRepository(db: DbExecutor): ProjectRepository {
  return {
    listActiveByOwner: (ownerId) =>
      db.select().from(projects)
        .where(and(eq(projects.ownerId, ownerId), eq(projects.isArchived, false)))
        .orderBy(desc(projects.createdAt)),

    async create(input) {
      const [row] = await db.insert(projects).values(input).returning();
      if (!row) throw new Error("insert into projects returned no row");
      return row;
    },

    async archive(id, ownerId) {
      const [row] = await db.update(projects).set({ isArchived: true })
        .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
        .returning();
      return row ?? null;
    },
  };
}
```

**Bündel und Unit of Work** `repositories/drizzle/create-repositories.ts` + `unit-of-work.ts`

```ts
export function createDrizzleRepositories(db: DbExecutor): Repositories {
  return { project: createDrizzleProjectRepository(db) };
}

export function createDrizzleUnitOfWork(db: AppDb): UnitOfWork {
  return { transaction: (work) => db.transaction((tx) => work(createDrizzleRepositories(tx))) };
}
```

### 5.4 Use Cases

Regeln (aus Tablepay):

- Fabrikfunktion `createXUseCases(deps)` gibt ein Interface zurück; Abhängigkeiten werden injiziert: `repos`, `uow`, Ports (Mailer, Storage, Clock `now`, externe Clients).
- Eingaben werden normalisiert und geprüft (auch wenn die Action schon Zod geparst hat: Use Cases sind die letzte Verteidigungslinie).
- Fehler sind **stabile Codes** als `as const`-Objekt pro Datei, geworfen als `UseCaseError(code)`. Nie UI-Text.
- Mehrschritt-Schreibvorgänge nur über `uow.transaction`.
- Kein Import von `next/*`, `react`, `src/platform/*/client`, Modul-`server.ts`/`client.ts` (Neutral-Entrypoint-Regel).

```ts
// use-cases/projects-use-cases.ts
import { isDbError } from "@/persistence/foundation/db-errors";
import type { ProjectRow, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";

export const PROJECT_ERROR = {
  invalidInput: "invalid_input",
  notFound: "not_found",
  duplicateName: "duplicate_name",
} as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR)[keyof typeof PROJECT_ERROR];

export type Project = { id: string; name: string; createdAt: Date };

export interface ProjectUseCases {
  listForOwner(ownerId: string): Promise<Project[]>;
  create(input: { ownerId: string; name: string }): Promise<Project>;
  archive(input: { ownerId: string; projectId: string }): Promise<void>;
}

export function createProjectUseCases(deps: { repos: Repositories; uow: UnitOfWork }): ProjectUseCases {
  return {
    async listForOwner(ownerId) {
      return (await deps.repos.project.listActiveByOwner(ownerId)).map(toProject);
    },

    async create({ ownerId, name }) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 120) throw new UseCaseError(PROJECT_ERROR.invalidInput);
      try {
        return toProject(await deps.repos.project.create({ ownerId, name: trimmed }));
      } catch (err) {
        if (isDbError(err, "unique")) throw new UseCaseError(PROJECT_ERROR.duplicateName);
        throw err;
      }
    },

    async archive({ ownerId, projectId }) {
      const row = await deps.repos.project.archive(projectId, ownerId);
      if (!row) throw new UseCaseError(PROJECT_ERROR.notFound);
    },
  };
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}
```

`use-cases/errors.ts`:

```ts
export class UseCaseError<C extends string = string> extends Error {
  override readonly name = "UseCaseError";
  constructor(readonly code: C) { super(code); }
}
```

### 5.5 Composition Root

```ts
// composition/create-request-services.ts
import "server-only";

export function createRequestServices() {
  const db = getDb();
  const repos = createDrizzleRepositories(db);
  const uow = createDrizzleUnitOfWork(db);
  const mailer = createSmtpMailer(); // Port-Bindung: einzige Stelle, die konkrete Adapter kennt

  return {
    projects: createProjectUseCases({ repos, uow }),
    // …
  };
}
export type RequestServices = ReturnType<typeof createRequestServices>;
```

```ts
// composition/request-services.ts  (einziges erlaubtes cache(createRequestServices))
import "server-only";
import { cache } from "react";
export const getRequestServices = cache(createRequestServices);
```

Regeln: Einstiegspunkte (Pages, Layouts, Read Models, Actions, Route Handler) holen Services **nur** über `getRequestServices()`; ein Request baut den Graphen genau einmal (Checker-Regel `request-services`: genau eine Datei darf `cache(createRequestServices)` enthalten). `create-request-services.ts` ist die einzige Datei unter `src/persistence/`, die konkrete Adapter aus `src/platform/*/server` binden darf.

### 5.6 Vertikaler Schnitt: Schema bis Seite

**Schema** `src/persistence/schema/projects.ts`

```ts
// Owner: src/modules/projects. Nur Repositories dieses Owners schreiben in diese Tabellen (§5.7).
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const projects = pgTable(
  "projects",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid().notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    isArchived: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_owner_idx").on(t.ownerId),
    uniqueIndex("projects_owner_name_key").on(t.ownerId, t.name),
  ],
);
```

**Server Action** `src/modules/projects/actions.ts`

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/platform/auth/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { PROJECT_ERROR } from "@/persistence/use-cases/projects-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createProjectInput } from "./core/schemas";
import type { ActionResult } from "@/shared/action-result";

export type CreateProjectErrorCode = "invalid_input" | "duplicate_name" | "unknown";

export async function createProjectAction(input: unknown): Promise<ActionResult<{ id: string }, CreateProjectErrorCode>> {
  const user = await requireUser(); // prüft Session erneut: Actions sind öffentliche Endpunkte
  const parsed = createProjectInput.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  try {
    const project = await getRequestServices().projects.create({ ownerId: user.id, name: parsed.data.name });
    revalidatePath("/dashboard/projects");
    return { status: "success", data: { id: project.id } };
  } catch (err) {
    if (err instanceof UseCaseError && err.code === PROJECT_ERROR.duplicateName) {
      return { status: "error", errorCode: "duplicate_name" };
    }
    return { status: "error", errorCode: "unknown" };
  }
}
```

**Read Model** `src/modules/projects/server/read-models.ts` (über `server.ts` veröffentlicht)

```ts
export const listProjectsProjection = cache((ownerId: string) =>
  getRequestServices().projects.listForOwner(ownerId),
);
```

**Seam** `src/app/(app)/dashboard/projects/page.tsx`

```tsx
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/platform/auth/server";
import { listProjectsProjection } from "@/modules/projects/server";
import { createProjectAction, archiveProjectAction } from "@/modules/projects/actions";
import { ProjectsPageClient } from "@/modules/projects/client";

export default async function ProjectsPage() {
  const user = await requireUser();
  const [projects, t] = await Promise.all([listProjectsProjection(user.id), getTranslations("projects")]);
  return (
    <ProjectsPageClient
      initialProjects={projects}
      createAction={createProjectAction}
      archiveAction={archiveProjectAction}
      copy={{ heading: t("heading"), errors: { duplicate_name: t("errors.duplicateName"), /* … */ } }}
    />
  );
}
```

### 5.7 Schema-Eigentum und Migrationen

**Wo die Modelle liegen:** zentral unter `src/persistence/schema/`, **eine Datei pro Owner** (`auth.ts` → `src/platform/auth`, `projects.ts` → `src/modules/projects`, …), zusammengeführt im Barrel `schema/index.ts`, den drizzle-kit liest. Nicht in den Modulen, weil:

- Fremdschlüssel und Joins Modulgrenzen überschreiten (`projects.ownerId → user.id`, `membership → workspace`, `invoice → reservation`). Modul-lokale Schemas würden die Tabellen eines Moduls faktisch zur öffentlichen API anderer Module machen.
- Drizzle-Relations beide Seiten brauchen; modul-lokal entstehen Import-Zyklen zwischen Modulen.
- Read Models häufig über Module hinweg joinen.
- die Datenbank ein gemeinsames Artefakt ist: ein Ort für Schema-Änderungen macht das Review einer Migration einfach.

**Eigentum sichtbar machen:**

- Jede Schema-Datei heißt wie ihr Owner und nennt ihn im Dateikopf. Das Owner-README listet seine Tabellen.
- Dateinamen in `src/persistence/` beginnen mit dem Owner-Namen (`projects-repository.ts`, `projects-use-cases.ts`), damit `src/persistence/**/projects*` alles zeigt, was der Owner in der Datenbank besitzt.
- **Nur der Owner schreibt:** `insert`/`update`/`delete` auf eine Tabelle stehen ausschließlich in Repositories ihres Owners. Andere Owner lesen per Join oder über die Use Cases des Owners. Das ist eine Review-Regel; statisch ist sie nur grob prüfbar und steht deshalb in `STRUCTURE.md` unter „Enforcement Limits“.

**Migrationen sind immer zentral:** pro Datenbank genau eine lineare Historie in `src/persistence/migrations/`. drizzle-kit vergleicht das gesamte Schema mit dem letzten Snapshot und erzeugt daraus eine Migration. Migrationen pro Modul gibt es nicht, weil Fremdschlüssel zwischen Modulen eine feste Reihenfolge brauchen.

**Arbeitsweise:**

- **Schema zuerst, dann generieren.** `pnpm db:generate` (= `drizzle-kit generate`). Migrationen werden nie von Hand oder von einer KI geschrieben.
- **Custom-SQL** (Funktionen, Trigger, Grants, Backfills, RLS-Policies, die Drizzle nicht abbildet): Quelle unter `src/persistence/sql/<name>/<name>.sql`, dann `pnpm db:generate:custom <name>` (leere Custom-Migration via `drizzle-kit generate --custom --name`, Skript kopiert die Quelle hinein; Tablepays `make drizzle-custom`).
- **Anwenden:** `pnpm db:migrate` = `scripts/db/migrate.mjs` mit `drizzle-orm/node-postgres/migrator`, zusätzlich (aus Deeplify):
  - Verbindung über `DATABASE_URL_MIGRATE` (Owner-Rolle, direkte Verbindung, nicht der Pooler).
  - `pg_advisory_lock` (ein Migrator gleichzeitig).
  - Banner mit Host/DB/Rolle; bei nicht-lokalem Host Abbruch, außer mit `--remote` plus Bestätigung des Hostnamens: lokal interaktiv, in der CI über `--expect-host=$MIGRATE_EXPECTED_HOST` (Abbruch, wenn der Host der URL nicht exakt übereinstimmt; ein vertauschtes Secret migriert so nie die falsche DB).
  - Regulär migriert nur die CI (§13). Agenten führen Remote-Migrationen nie ohne ausdrückliche Freigabe aus.
  - `--status` listet angewendet/ausstehend.
- **Drift-Check in der CI:** `drizzle-kit generate` darf keine neue Datei erzeugen; sonst wurde das Schema ohne Migration geändert (§11.3).
- **Seed:** `pnpm db:seed` nur gegen lokale Hosts und den Test-Stack (Allowlist), sonst Abbruch. Der Seed enthält nur Referenzdaten, die kein Test verändert.
- **Reset:** `pnpm db:reset` (lokal: Schema droppen, migrieren, seeden).
- **Merge-Konflikte in `src/persistence/migrations/`** (Tablepay-Prozedur): nicht zeilenweise auflösen. Prüfen, ob eigene Custom-Migrationen existieren (dann stoppen und fragen); sonst Ordner vom Zielbranch übernehmen, `pnpm db:generate` erneut ausführen, `pnpm db:reset` zur Verifikation.
- Migrationen laufen **vor** dem Deploy als eigener CI-Schritt der Zielumgebung, nie im Build. Sie werden rückwärtskompatibel geschrieben (Expand/Contract, §13.2).

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

try { process.loadEnvFile(".env.local"); } catch { /* CI/Test-Stack setzen Env direkt */ }

export default defineConfig({
  dialect: "postgresql",
  schema: "./persistence/schema/index.ts",
  out: "./persistence/migrations",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE ?? "" }, // nur für studio/migrate; generate braucht keine DB
});
```

### 5.8 DB-Rollen und optionale Row Level Security

**Standard (immer):** drei Rollen, drei URLs.

| Rolle | Env | Rechte | Nutzung |
|---|---|---|---|
| `app_owner` (bzw. Anbieter-Owner) | `DATABASE_URL_MIGRATE` | besitzt alle Objekte, DDL | nur `scripts/db/*`, `drizzle.config.ts` |
| `app_runtime` (LOGIN) | `DATABASE_URL` | `usage` auf Schemas `public`/`auth`, DML auf Tabellen, `usage` auf Sequenzen, **keine** DDL | Anwendung inkl. Better Auth |
| `app_public` (LOGIN) | `DATABASE_URL_PUBLIC` | nur exakt die Rechte, die unauthentifizierte öffentliche Pfade brauchen (z. B. `select` auf die ausgelieferte Tabelle, `insert`/`select`/`delete` auf die Rate-Limit-Tabelle), sonst nichts | ausschließlich `src/persistence/foundation/**` und die schmale Composition-Naht dieser Pfade |

Rollen sind clusterweit und werden per `scripts/db/bootstrap-roles.mjs` (lokal/Test-Stack) bzw. über die Konsole des Anbieters angelegt; Grants inkl. `alter default privileges` kommen als Custom-Migration. Migrationen prüfen, dass `app_runtime` und `app_public` existieren, und brechen sonst laut ab (Deeplify-Muster).

**`app_public`: eigene Rolle für unauthentifizierte öffentliche Pfade.** Endpunkte ohne Session (z. B. Ausliefern öffentlicher Dateien nach Host, öffentliche Rate-Limits/Caches, tokenbasierte Bestätigungs-/Abmelde-Links) laufen mit einer eigenen, minimalen Rolle statt mit `app_runtime`:

- eigener, kleiner Pool in `src/persistence/foundation/` (eigene `DATABASE_URL_PUBLIC`, gleicher Treiber wie der Rest).
- eigene, schmale Composition-Naht, z. B. `src/persistence/composition/public-services.ts`, die ausschließlich die Repositories/Use Cases dieser Pfade freigibt.
- die gesamte Fachlogik bleibt in TypeScript; die Rolle begrenzt nur, was die Verbindung in der Datenbank berühren kann.
- ein `*.db.test.ts` belegt die Grenze: es verbindet mit `app_public` und prüft, dass die Rolle keine anderen Tabellen lesen oder schreiben kann.

Grund: Ein Bug in einem unauthentifizierten Pfad darf nicht den Rest des Schemas erreichen können, Defense in Depth an der Stelle, an der früher RLS diese Rolle übernahm (Deeplifys `checker_public`-Muster). RLS (unten) bleibt ein optionales Rezept für authentifizierte, nutzergebundene Isolation und ersetzt `app_public` nicht: Für Pfade ohne Session greift `app.current_user_id()` ohnehin nicht.

**Option (Rezept, pro Projekt entscheiden): RLS als zweite Verteidigungslinie.** Deeplifys `withUser`-Muster auf die Unit of Work übertragen:

```ts
interface UnitOfWork {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  asUser<T>(userId: string, work: (repos: Repositories) => Promise<T>): Promise<T>;
}
// asUser: db.transaction(async (tx) => {
//   await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
//   await tx.execute(sql`set local role app_user`);
//   return work(createDrizzleRepositories(tx));
// })
```

`app_user` (NOLOGIN) trägt Grants + Policies (`app.current_user_id()` = `nullif(current_setting('app.user_id', true), '')::uuid`); `app_runtime` ist Mitglied mit `SET TRUE, INHERIT FALSE` für die RLS-Pfade. Policies als Drizzle-`pgPolicy` oder Custom-SQL, Tests mit echten Rollen (`*.db.test.ts`). Kosten: jede nutzergebundene Operation läuft in einer Transaktion; Nutzen: ein vergessener `ownerId`-Filter ist kein Datenleck. **Empfehlung:** aus, solange die Repository-Regel „Scope-ID in jeder Methode“ gilt; an, sobald sensible Mandantendaten oder mehrere Schreibpfade (Cron, Webhooks, Admin) auf dieselben Tabellen zugreifen.

### 5.9 Anbieter-Matrix

| Umgebung | `DATABASE_URL` (Runtime, `app_runtime`) | `DATABASE_URL_PUBLIC` (`app_public`) | `DATABASE_URL_MIGRATE` (Owner) |
|---|---|---|---|
| lokal (`docker/compose.yml`) | `postgres://app_runtime:…@127.0.0.1:<port>/app` | `postgres://app_public:…@127.0.0.1:<port>/app` | `postgres://postgres:…@127.0.0.1:<port>/app` |
| Test-Stack (`docker/compose.test.yml`, lokal und CI) | `postgres://app_runtime:test@postgres:5432/app` | `postgres://app_public:test@postgres:5432/app` | `postgres://app_owner:test@postgres:5432/app` |
| Neon | Pooled Host (`-pooler`), `sslmode=require` | Pooled Host (`-pooler`), `sslmode=require` | Direct Host |
| Supabase (nur als Postgres) | Supavisor Transaction Mode (Port 6543) | Supavisor Transaction Mode (Port 6543) | Direct / Session Mode (5432) |
| RDS / Hetzner / eigener Server | über PgBouncer oder direkt | über PgBouncer oder direkt | direkt |

Region der Vercel-Functions gleich der DB-Region setzen (Deeplify: `fra1` ↔ `eu-central-1`). Neon-Branches pro PR sind ein optionales Extra, kein Muss.

---

## 6. Auth mit Better Auth

### 6.1 Prinzip

**Better Auth besitzt Identität und Session. Alles Fachliche (Mandanten, Mitgliedschaften, Rollen, Rechte) sind eigene Tabellen und Use Cases.** Dadurch bleibt ein Wechsel des Auth-Frameworks eine Änderung in `src/platform/auth` + `schema/auth.ts`, nicht im ganzen Produkt. Das `organization`-Plugin wird deshalb bewusst nicht standardmäßig genutzt.

### 6.2 Aufbau

| Datei | Inhalt |
|---|---|
| `src/persistence/schema/auth.ts` | Owner `src/platform/auth`. Tabellen `user`, `session`, `account`, `verification`, `rateLimit` in `pgSchema("auth")`. Einmalig mit der Better-Auth-CLI (`@better-auth/cli generate`) erzeugt, danach normale Drizzle-Schemadatei. IDs als UUID (`advanced.database.generateId: "uuid"`), Spaltentyp im generierten Schema prüfen |
| `src/persistence/composition/auth-database.ts` | Narrow Entry: `getAuthDb()` + `authSchema` für den Adapter |
| `src/platform/auth/server/auth.ts` | lazy `getAuth()` (Instanz erst beim ersten Zugriff, damit Build/Tests ohne Auth-Env laufen) |
| `src/platform/auth/server/session.ts` | `getCurrentUser()` (`react cache`, `unstable_rethrow`, bei Fehlern `null`), `requireUser()` (→ `redirect("/login?next=…")`) |
| `src/platform/auth/server/emails/` | Magic-Link-Mail (React Email), versendet über `src/platform/mailer` |
| `src/platform/auth/server.ts` | veröffentlicht `getAuth`, `getCurrentUser`, `requireUser`, `authRouteHandlers` |
| `src/platform/auth/proxy-gate.ts` | zusätzlicher Subpath: `hasSessionCookie(req)` über `better-auth/cookies`, ohne DB/Netz, damit der Proxy nichts aus dem Auth-Graphen lädt |
| `src/app/api/auth/[...all]/route.ts` | `GET`/`POST` delegieren an `authRouteHandlers` |
| `src/modules/sign-in/` | Login-UI, `actions.ts` (`signInWithMagicLinkAction`, `signOutAction`), `safeNextPath` gegen Open Redirects |

### 6.3 Konfiguration (Deeplify-Werte)

```ts
function buildAuth() {
  const env = serverEnv();
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,                         // ≥ 32 Zeichen, sonst Startfehler
    database: drizzleAdapter(getAuthDb(), { provider: "pg", schema: authSchema }),
    trustedOrigins: [env.APP_URL],
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({ sendMagicLink, expiresIn: 15 * 60, storeToken: "hashed", rateLimit: { window: 60, max: 3 } }),
      nextCookies(),                                        // muss das letzte Plugin sein
    ],
    rateLimit: { enabled: true, storage: "database", customRules: { "/sign-in/magic-link": { window: 60, max: 3 } } },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },  // nur hinter vertrauenswürdigem Proxy (Vercel)
      useSecureCookies: env.NODE_ENV === "production",
    },
    session: { expiresIn: 30 * 86_400, updateAge: 86_400, cookieCache: { enabled: true, maxAge: 300 } },
  });
}
```

Invarianten: Cookies host-only (kein `crossSubDomainCookies`), `Secure` in Produktion, `SameSite=Lax` (Magic-Link-Klick ist eine Cross-Site-Navigation), Token nur gehasht in der DB, Rate-Limit in der DB (serverless-fest, kein Redis), Mailversand über unser SMTP.

**Rate-Limits gelten nur im HTTP-Router.** Better Auth wendet seine Rate-Limits (z. B. das Magic-Link-Limit oben) ausschließlich in seinem eigenen HTTP-Router an. Ruft eine Server Action `auth.api.*` direkt auf, umgeht sie das Limit, in einem realen Projekt geschehen: Das Login-Formular ließ unbegrenzt viele Magic-Link-Mails zu. Regel: ratenbegrenzte Auth-Endpunkte (Sign-in, weitere) werden aus Server Actions über `getAuth().handler(request)` mit einem aus dem eingehenden Request gebauten `Request`-Objekt aufgerufen (damit IP-Header und die Router-Middleware greifen), oder direkt vom Client über Better Auths eigenen Client. Ein E2E-Test reicht dafür das echte Login-Formular öfter als das Limit ein und prüft die Limit-Meldung (§10.4).

### 6.4 Request-Fluss

```text
Request /dashboard/…
  └─ src/proxy.ts           nur Cookie-Präsenz (hasSessionCookie) → sonst 307 /login?next=…
       └─ (app)/layout  getCurrentUser() validiert echt (Cookie-Cache, sonst DB) → sonst redirect
            └─ page     requireUser() (gecacht, kein zweiter DB-Zugriff)
                 └─ actions.ts  requireUser() / requirePermission() ERNEUT, Actions sind eigene Endpunkte
```

- Marketing-Seiten lesen nie Cookies/Session (bleiben statisch).
- Seiten mit Session sind dynamisch; Cookies setzt Better Auth nur in Route Handlern/Server Actions (`nextCookies()`).
- `src/proxy.ts`-Matcher statisch auf geschützte Pfade (`/dashboard/:path*`); Laufzeit-Guards im Code, weil Matcher keine Env-Werte auswerten.

### 6.5 Erweiterungen (bei Bedarf, nicht im Template aktiv)

| Bedarf | Better-Auth-Baustein |
|---|---|
| 6-stelliger Code statt Link (Tablepay-Flow, Mobile) | `emailOTP`-Plugin |
| Mobile App / externe API-Clients | `bearer`- bzw. `jwt`-Plugin; Route Handler prüfen über `src/platform/api-pipeline` |
| Passkeys, Social Login | entsprechende Plugins; Kontenverknüpfung bewusst konfigurieren |
| Admin-Impersonation | `admin`-Plugin, nur mit Audit-Log |

### 6.6 Autorisierung

`src/platform/access` (sobald Mandanten existieren), nach Tablepays `host-access`:

```ts
export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  projectsRead: "projects.read",
  projectsWrite: "projects.write",
  membersManage: "members.manage",
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: Object.values(PERMISSIONS),
  admin: [PERMISSIONS.projectsRead, PERMISSIONS.projectsWrite, PERMISSIONS.membersManage],
  member: [PERMISSIONS.projectsRead],
};
```

`requirePermission(workspaceId, permission)` in `src/platform/access/server` liest die Mitgliedschaft über einen Use Case, gibt `{ user, workspace, role }` zurück und wirft sonst einen Zugriffsfehler, den Actions und die API-Pipeline auf Codes abbilden. Rechte werden an **Bündel** gebunden, nie an Rollen-Strings im UI-Code.

---

## 7. Request-Pfade und Fehlervertrag

| Pfad | Mechanismus | Fehlerform |
|---|---|---|
| Lesen (UI) | Server Component → `src/modules/x/server.ts` Read Model (`cache`) → `getRequestServices()` | Error-Boundary / leerer Zustand mit Retry |
| Schreiben (UI) | Client ruft `src/modules/x/actions.ts` → Use Case → `revalidatePath`/`revalidateTag` | `ActionResult` = `{ status: "success", data } \| { status: "error", errorCode }` |
| Externe HTTP-API | `src/app/api/**/route.ts` über `src/platform/api-pipeline` (`access → parse → execute → respond`) | `{ "errorCode": "…" }` + HTTP-Status |
| Webhooks | eigener Route Handler: Signatur prüfen, idempotent verarbeiten (Event-ID in DB) | Klartext, Provider-Retry-Semantik |
| Cron | `src/app/api/cron/*`, `Authorization: Bearer $CRON_SECRET` (timing-safe), `maxDuration` setzen | Klartext |

Regeln:

- Use Cases werfen `UseCaseError(code)`; Actions/Routes übersetzen per expliziter Tabelle in ihre eigenen Codes (`mapRuntimeUseCaseError` aus der Pipeline). Unbekanntes → `unknown`.
- Die UI übersetzt Codes über i18n-Schlüssel. **Nie** auf Fehlertexte von Providern oder Postgres verzweigen.
- Server Actions werfen nur für `redirect`/`notFound`; alles andere ist ein `ActionResult`.
- Die API-Pipeline wird aus Tablepay 1:1 portiert (`core/handler-factory.ts`, `core/request-validation.ts`, `core/error-mapping.ts`, `core/responses.ts`), ergänzt um `server/cron-auth.ts` und `server/require-session-access.ts`. Routen, die bewusst nicht die Pipeline nutzen, stehen mit Grund im Pipeline-README.

---

## 8. Frontend-Konventionen

Aus Tablepay (AGENTS) und Deeplify (Branding) zusammengeführt:

- Server Components zuerst; `"use client"`, `useEffect`, `useState` minimieren; Client-Grenze so klein wie möglich. Kein Memoizing auf Verdacht.
- **Feedback innerhalb ~100 ms** für jede Nutzeraktion: auslösendes Element sofort pending/disabled (`useTransition`, `useFormStatus`, `usePendingNavigation`). Langsame Routen bekommen `loading.tsx`.
- Keine leeren Fehlerflächen: lokalisierter Fehlerzustand + Retry.
- Keine hart codierten Farben; nur semantische Tokens. Kontrastregeln im Design-Token-Set festhalten (Deeplify: kleiner Akzenttext nur über eine „strong“-Variante).
- Keine hart codierten UI-Texte; alles über next-intl. Übersetzte Zod-Meldungen in UI-Schemas werden injiziert.
- Geschlossene String-Mengen als `as const` + abgeleitete Union, keine Enums, keine duplizierten Literale.
- Komponenten single-purpose; keine `*Manager`- oder God-Komponenten; ab mehreren Effekten Hook/Controller extrahieren (Tablepay: `use-products-page-controller.ts`).
- Kontakt/Mail-Links nie nur `mailto:` (Deeplify-Lehre): Popup mit kopierbarer Adresse.
- Security-Header (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) zentral in `next.config.ts`, per E2E-Test abgesichert.

---

## 9. Konfiguration und Umgebungsvariablen

**`src/platform/env`** ist der einzige Leser von `process.env` im App-Code (Checker-Regel `env-access`; Ausnahmen: `next.config.ts`, `drizzle.config.ts`, `instrumentation*.ts`, `scripts/**`, Test-Konfiguration).

```ts
// src/platform/env/server/env.ts
import "server-only";
import { z } from "zod";

const ServerEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  DATABASE_URL_PUBLIC: z.url().optional(), // nur wenn unauthentifizierte öffentliche Pfade existieren (§5.8)
  BETTER_AUTH_SECRET: z.string().min(32),
  SMTP_URL: z.string().min(1),           // smtp(s)://user:pass@host:port
  MAIL_FROM: z.string().min(3),
  CRON_SECRET: z.string().min(32),
  SENTRY_DSN: z.url().optional(),
  APP_COMMIT_SHA: z.string().optional(), // im CI-Build gesetzt, für den Deploy-Check
});

let cached: z.infer<typeof ServerEnv> | undefined;
/** Lazy: erst beim ersten Zugriff validiert, damit `next build` ohne Laufzeit-Secrets geht. */
export function serverEnv() { return (cached ??= ServerEnv.parse(process.env)); }
```

`src/platform/env/index.ts` exportiert die öffentlichen `NEXT_PUBLIC_*`-Werte (statisch referenziert, damit Next sie inlinen kann).

| Variable | Pflicht | Wo gelesen |
|---|---|---|
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | ja | env |
| `DATABASE_URL` | ja | `src/persistence/foundation/client.ts` via env |
| `DATABASE_URL_PUBLIC` | wenn unauthentifizierte öffentliche Pfade existieren (§5.8) | nur `src/persistence/foundation/**` + Skripte |
| `DATABASE_URL_MIGRATE` | für Migrationen | nur `scripts/db/*`, `drizzle.config.ts` |
| `BETTER_AUTH_SECRET` | ja | `src/platform/auth` via env |
| `SMTP_URL`, `MAIL_FROM` | ja | `src/platform/mailer` via env |
| `CRON_SECRET` | wenn Cron | `src/platform/api-pipeline/server/cron-auth.ts` |
| `APP_COMMIT_SHA` | Staging/Production (im CI-Build gesetzt) | `/api/health` (Deploy-Check, §13.4) |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | optional | `src/platform/observability`, Build |
| `S3_*`, `NEXT_PUBLIC_POSTHOG_*` | Rezepte | jeweiliges Platform-Concern |

Dateiregeln:

- `.env.example` ist versioniert, vollständig kommentiert, ohne Werte; Agenten dürfen sie lesen und pflegen.
- `.env.local` = lokale Docker-DB/Mailpit aus `docker/compose.yml`. Agenten öffnen, lesen oder ändern `.env*`-Dateien außer `.env.example` nicht; Skripte laden sie selbst (`process.loadEnvFile`).
- `.gitignore` enthält `.env*` mit Ausnahme `!.env.example`. Das ist der einzige Schutz gegen versehentlich committete Secrets (es gibt keine Git-Hooks).
- Test-Env (nur Dummy-Werte) steht direkt in `docker/compose.test.yml` und ist versioniert; es gibt keine `.env.test`.
- Produktions-Secrets nur im Hosting (Vercel) bzw. in gitignorten Dateien mit Namen, die Next nie lädt (z. B. `.secrets.production.local`). **Nie** `.env.production(.local)` anlegen.

---

## 10. Teststrategie

### 10.1 Ebenen

| Ebene | Ort / Suffix | Läuft gegen | Befehl |
|---|---|---|---|
| Unit: reine Logik, Use Cases, Actions, Komponenten | beim Owner, `*.test.ts(x)` | nichts: keine DB, kein Netz, keine echte Zeit, keine Env | `pnpm test` (Host) |
| Repositories, Constraints, Grants, RLS | beim Owner, meist `src/persistence/tests/*.db.test.ts` | echtes Postgres, jeder Test in Transaktion mit Rollback | `pnpm test:docker` (Referenz), `pnpm test:db` (Host gegen `docker/compose.yml`) |
| Owner-übergreifend, Route Handler, Webhooks, externe Verträge | `tests/integration/{http,webhooks,workflows,compatibility}/*.integration.test.ts` | Route Handler direkt aufgerufen, DB echt | `pnpm test:docker` (Referenz), `pnpm test:int` (Host) |
| E2E | `tests/e2e/*.spec.ts` | Production-Build + Postgres + Mailpit im Test-Stack | `pnpm test:e2e:docker` (Referenz), `pnpm test:e2e` (Host) |
| Struktur / Guards | `scripts/structure/tests/` + Checker | Repository-Baum | `pnpm verify:structure` |

**Maßgeblich ist der Docker-Lauf.** Ist ein Test auf dem Host grün und im Test-Stack rot, gilt der Test-Stack. Die CI führt exakt dieselben Befehle aus. Unit-Tests laufen auf dem Host: sie brauchen keine Dienste, und gleiche Ergebnisse auf jedem Gerät sichern gepinnte Node-Version und Lockfile.

### 10.2 Unit-Tests: strikt ohne I/O

| Was wird getestet | Abhängigkeiten | Technik |
|---|---|---|
| Reine Logik (`core/`: Validierung, Berechnungen, Mapper, Zod-Schemas) | keine | direkt aufrufen, nichts mocken |
| Use Cases | Repositories, Unit of Work, Ports (Mailer, Storage), Uhr | **typisierte Fakes per Dependency Injection**, kein `vi.mock` |
| Server Actions / Route Handler | `requireUser`, `getRequestServices`, `next/cache`, `next/navigation` | `vi.mock` auf den Modulpfad, den der Code tatsächlich lädt (Tablepay `product-actions.test.ts`) |
| Client-Komponenten | Props, auch die Actions | Testing Library + jsdom, Action als `vi.fn()`-Prop |
| Repositories | die DB selbst | **kein Unit-Test**, sondern `*.db.test.ts` gegen echtes Postgres |

**Fakes statt Mocks für Repositories.** Tablepay mockt Repositories mit `vi.fn()` und `as never`-Casts: Die Casts umgehen die Typprüfung, und die Tests prüfen Aufrufe statt Verhalten. Im Template gibt es eine typisierte In-Memory-Implementierung der Contracts:

```ts
// src/persistence/tests/support/fake-repositories.ts
export function createFakeRepositories(seed: { projects?: ProjectRow[] } = {}) {
  const projects = [...(seed.projects ?? [])];

  const repos: Repositories = {
    project: {
      async listActiveByOwner(ownerId) {
        return projects.filter((p) => p.ownerId === ownerId && !p.isArchived);
      },
      async create(input) {
        if (projects.some((p) => p.ownerId === input.ownerId && p.name === input.name)) {
          throw fakeDbError("23505", "projects_owner_name_key"); // wird von isDbError(err, "unique") erkannt
        }
        const row: ProjectRow = { id: crypto.randomUUID(), isArchived: false, createdAt: new Date(0), ...input };
        projects.push(row);
        return row;
      },
      async archive(id, ownerId) {
        const row = projects.find((p) => p.id === id && p.ownerId === ownerId);
        if (!row) return null;
        row.isArchived = true;
        return row;
      },
    },
  };

  // Kein Rollback! Rollback-Verhalten wird in *.db.test.ts geprüft.
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  return { repos, uow, state: { projects } };
}
```

```ts
it("meldet doppelte Namen als duplicate_name", async () => {
  const { repos, uow } = createFakeRepositories({ projects: [projectRow({ ownerId: "u1", name: "Alpha" })] });
  const projects = createProjectUseCases({ repos, uow });

  await expect(projects.create({ ownerId: "u1", name: "  Alpha " }))
    .rejects.toMatchObject({ code: "duplicate_name" });
});
```

Regeln:

- Ändert sich ein Repository-Contract, bricht der Fake beim Kompilieren. Für Repositories mit nicht-trivialer Logik läuft dieselbe Contract-Suite gegen Fake (unit) und Drizzle-Implementierung (`*.db.test.ts`), damit der Fake nicht vom echten Verhalten abweicht (wie Deeplifys Paritätstests).
- Zeit, Zufall und IDs werden injiziert (`now: () => Date`, ID-Generator) oder mit `vi.useFakeTimers()` gesteuert.
- Drittanbieter nie direkt mocken, sondern hinter einem eigenen Port: der Mailer ist ein Interface in `src/platform/mailer`, im Test ein Fake, der gesendete Mails sammelt. Kein `vi.mock("nodemailer")`.
- Viel Mocking ist ein Designsignal: Braucht ein Test fünf `vi.mock`, gehört die Logik aus der Action in einen Use Case oder nach `core/`.
- Unit-Tests bleiben schnell. Default-Umgebung `node`, jsdom nur per Datei-Direktive, kein `server.deps.inline` für `next`, Route-Handler-Tests mit großem Import-Graphen gehören ins Integration-Projekt. (Messung: Deeplify 80 Dateien/1.754 Tests in 10 s CI; Tablepay 151 Dateien/802 Tests in 2:33 min, hauptsächlich wegen dieser Punkte.)

**Durchsetzung zur Laufzeit.** Das Vitest-Projekt `unit` lädt eine Setup-Datei, die I/O hart blockiert; `db` und `integration` laden sie nicht:

```ts
// scripts/test/unit-guard.ts
import { vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {
    constructor() { throw new Error("DB-Zugriff im Unit-Test. Fakes nutzen oder *.db.test.ts schreiben."); }
  },
}));
vi.stubGlobal("fetch", () => { throw new Error("Netzwerkzugriff im Unit-Test. fetch injizieren."); });
for (const key of ["DATABASE_URL", "DATABASE_URL_PUBLIC", "DATABASE_URL_MIGRATE", "SMTP_URL", "BETTER_AUTH_SECRET"]) delete process.env[key];
```

### 10.3 Docker-Test-Stack

```text
docker/
  app.Dockerfile       Stufen: deps (pnpm install mit Cache-Mount) → tools (Quellcode + Dev-Deps: Migrationen, Seed, Vitest)
                                                                    → build (next build) → runner (next start)
  e2e.Dockerfile       FROM mcr.microsoft.com/playwright:v<exakt @playwright/test-Version>-noble
  test-db-init/         initdb-SQL (z. B. 00_roles.sql): legt app_owner/app_runtime/app_public mit festen Test-Passwörtern an
docker/compose.yml            Entwicklung: Postgres + Mailpit mit Host-Ports für `pnpm dev`
docker/compose.test.yml       hermetischer Test-Stack, eigener Projektname, keine Host-Ports
```

```yaml
# docker/compose.test.yml (Skizze)
name: app-test
services:
  postgres:
    image: postgres:18                    # pgTAP-Variante nur, wenn das Projekt SQL-Ebene-Tests behält
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
      POSTGRES_INITDB_ARGS: "--locale=C --encoding=UTF8"   # Anbieter wie Neon nutzen C-Collation; en_US.utf8 sortiert anders und bricht ordersensitive Assertions
    volumes: ["./docker/test-db-init:/docker-entrypoint-initdb.d:ro"]   # legt app_owner/app_runtime/app_public mit festen Test-Passwörtern an
    tmpfs: /var/lib/postgresql            # jede Runde frisch und schnell (Postgres 18)
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 2s, retries: 30 }

  mailpit:
    image: axllent/mailpit:<gepinnte Version>

  migrate:                                # Einmal-Job: Migrationen, Seed (Rollen kommen aus dem initdb-Skript, nicht aus db:bootstrap)
    build: { context: ., dockerfile: docker/app.Dockerfile, target: tools }
    command: sh -c "pnpm db:migrate && pnpm db:seed"   # seedet immer mit: einige DB-Tests hängen an Referenzdaten aus dem Seed
    environment: { DATABASE_URL_MIGRATE: "postgres://app_owner:test@postgres:5432/app" }   # Owner aus dem initdb-Skript, KEIN Superuser
    depends_on: { postgres: { condition: service_healthy } }

  tests:                                  # pnpm test:docker: *.db.test.ts + integration-tests
    build: { context: ., dockerfile: docker/app.Dockerfile, target: tools }
    command: sh -c "pnpm test:db && pnpm test:int"
    environment:
      DATABASE_URL: postgres://app_runtime:test@postgres:5432/app
      DATABASE_URL_PUBLIC: postgres://app_public:test@postgres:5432/app
      DATABASE_URL_MIGRATE: postgres://app_owner:test@postgres:5432/app
      SMTP_URL: smtp://mailpit:1025
    depends_on: { migrate: { condition: service_completed_successfully } }

  app:                                    # echter Production-Build, kein next dev
    build:
      context: .
      dockerfile: docker/app.Dockerfile
      target: runner
      args: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }   # NEXT_PUBLIC_* werden beim Build eingebacken
    environment:
      APP_URL: http://localhost:3000
      DATABASE_URL: postgres://app_runtime:test@postgres:5432/app
      DATABASE_URL_PUBLIC: postgres://app_public:test@postgres:5432/app
      SMTP_URL: smtp://mailpit:1025
      MAIL_FROM: test@example.test
      BETTER_AUTH_SECRET: test-secret-only-for-the-docker-test-stack-0000
      CRON_SECRET: test-cron-secret-only-for-the-docker-test-stack-00
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"] }

  e2e:
    build: { context: ., dockerfile: docker/e2e.Dockerfile }
    network_mode: "service:app"           # Browser sieht http://localhost:3000 (Secure Context)
    environment:
      E2E_BASE_URL: http://localhost:3000
      MAILPIT_API_URL: http://mailpit:8025
      DATABASE_URL_MIGRATE: postgres://app_owner:test@postgres:5432/app   # für Daten-Factories
      BETTER_AUTH_SECRET: test-secret-only-for-the-docker-test-stack-0000    # für signierte Test-Sessions
    depends_on: { app: { condition: service_healthy } }
    volumes: ["./playwright-report:/work/playwright-report", "./test-results:/work/test-results"]
```

`scripts/test/docker.mjs` (hinter `pnpm test:docker` und `pnpm test:e2e:docker`) liest die Playwright-Version aus `package.json` und übergibt sie als Build-Argument, führt `docker compose -f docker/compose.test.yml --project-directory <Repo-Wurzel> run --rm --build <tests|e2e> [Argumente]` aus (die relativen Pfade der Compose-Datei gelten damit ab der Repo-Wurzel, §3), räumt immer mit `down -v` auf und gibt den Exit-Code der Tests zurück. Argumente werden an Playwright durchgereicht (z. B. `--grep @smoke`, `--shard=1/4`).

Gelöste Stolperfallen:

1. **Secure Cookies.** Die App läuft mit `NODE_ENV=production` und setzt `Secure`-Cookies; Chromium akzeptiert sie über HTTP nur auf `localhost`. Deshalb teilt der E2E-Container per `network_mode: service:app` den Netzwerk-Namespace der App: Der Browser spricht `localhost` an, genau wie lokal, und der Magic Link in der Mail zeigt auf dieselbe Adresse. Das gilt auch für die Clipboard-API.
2. **`--abort-on-container-exit` beendet alles, sobald der Migrations-Job fertig ist.** Deshalb `compose run`: startet die Abhängigkeiten, wartet auf ihre Bedingungen und liefert den Exit-Code der Tests.
3. **`node_modules` vom Mac funktioniert im Linux-Container nicht** (esbuild, lightningcss, Tailwind oxide). `pnpm install` läuft im Image, nicht per Bind-Mount; ein BuildKit-Cache-Mount für den pnpm-Store hält das schnell.
4. **Playwright-Image-Version = `@playwright/test`-Version**, erzwungen über das Build-Argument aus `package.json`.
5. **Keine Host-Ports im Test-Stack:** keine Kollision mit `pnpm dev` oder anderen lokalen Projekten. Die Test-DB liegt im tmpfs und ist bei jedem Lauf frisch.
6. **Migrations-Owner ist kein Superuser.** Anders als lokal (der `postgres`-Superuser in `docker/compose.yml`) legt das initdb-Skript im Test-Stack einen echten `app_owner` ohne Superuser-Rechte an, wie bei den meisten Anbietern (Neon, Supabase). Sonst würden Grants und `alter default privileges` aus den Migrationen nie wirklich geprüft.
7. **Der Migrate-Job seedet immer mit.** `pnpm db:seed` läuft im selben Job wie `pnpm db:migrate`: Einige `*.db.test.ts`/`*.integration.test.ts` hängen von Referenzdaten aus dem Seed ab; ein separater „nur migriert, nicht geseedet"-Zustand wäre ungetestet.

**Zwei Modi:**

| Modus | Wofür | Befehl |
|---|---|---|
| Docker (Referenz) | CI, „ist es wirklich grün?“ vor dem PR | `pnpm test:docker`, `pnpm test:e2e:docker` |
| Host | Tests schreiben, UI-Mode, Debuggen | `pnpm infra:up`, dann `pnpm test:e2e --ui` bzw. `pnpm test:e2e <spec>` |

Traces und Reports landen per Volume auf dem Host (`pnpm exec playwright show-trace …`). Screenshot-Vergleiche, falls eingeführt, werden nur im Docker-Modus erzeugt und verglichen.

### 10.4 Datenisolation in E2E

Kein Reset pro Testfall: Alle Playwright-Worker sprechen mit derselben App und derselben DB, ein Reset würde parallel laufenden Tests die Daten entziehen und `workers: 1` erzwingen. Die App hat außerdem eigene Verbindungen und Caches, ein Rollback wie in `*.db.test.ts` ist nicht möglich. Parallel existierende Testdaten prüfen nebenbei die Mandanten-Isolation (Deeplify `isolation.spec.ts`).

**1. Pro Lauf: frische DB.** Test-Stack mit Postgres im tmpfs, einmal migrieren und seeden. Der Seed enthält nur Referenzdaten, die kein Test verändert.

**2. Pro Test: eigene, eindeutige Daten per Fixture.**

```ts
// tests/e2e/helpers/fixtures.ts
export const test = base.extend<{ user: TestUser }>({
  user: async ({ context, baseURL }, use, testInfo) => {
    const user = await createTestUser(testInfo.title);   // e2e-<label>-<zufall>@example.test
    await loginAs(context, user, baseURL!);              // Session direkt gesetzt, kein Mail-Umweg
    await use(user);
    await deleteUser(user.id);                           // on delete cascade räumt alles des Nutzers ab
  },
});

test("archiviert ein Projekt", async ({ page, user }) => {
  const project = await createProject(user, { name: "Alpha" }); // Factory per SQL, schnell
  // … nur die UI-Aktion testen, um die es geht
});
```

- Jeder Test hat seinen eigenen Nutzer; alle Fachdaten hängen per Fremdschlüssel mit `on delete cascade` an ihm. Aufräumen ist im Test-Stack überflüssig und dient dem Host-Modus.
- Factories schreiben per `pg` direkt in die DB (E2E importiert keinen App-Code). Die UI wird nur für den Ablauf benutzt, der getestet wird.
- Assertions beziehen sich auf eigene Daten, nie auf Gesamtzahlen („Liste enthält Alpha“ statt „Liste hat 1 Eintrag“).

**3. Login ohne Mail, außer im Login-Test.** `auth.spec.ts` spielt den echten Magic-Link-Weg über Mailpit durch. Alle anderen Tests legen Nutzer und Session direkt an und setzen das signierte Cookie selbst (Deeplifys `createTestUser`/`loginAs`). Das ist schnell und umgeht das Magic-Link-Rate-Limit (3 pro 60 s pro IP; im Test-Stack haben alle Worker dieselbe IP). Der Helfer setzt dabei **beide Cookie-Varianten**: die `__Secure-`-präfixierte (Production-Server, von Playwright bzw. dem Docker-Test-Stack gestartet, `useSecureCookies` true) und die einfache (ein wiederverwendeter `next dev`-Server). Die App liest ohnehin nur den Namen, den sie je nach `useSecureCookies` erwartet, damit funktioniert derselbe Helfer in beiden Modi (Docker-Test-Stack und Host-Modus gegen einen laufenden `next dev`), ohne den Modus selbst zu erkennen. Weil die Cookie-Signatur Interna von Better Auth nachbildet, prüft ein Guard-Test, dass eine so erzeugte Session auf einer geschützten Seite angenommen wird; ein Better-Auth-Update fällt dadurch sofort auf.

**Rate-Limit-Test.** Weil Better Auths Rate-Limits nur im HTTP-Router gelten und ein direkter `auth.api.*`-Aufruf aus einer Server Action sie umgeht (§6.3), reicht `auth.spec.ts` das echte Login-Formular öfter als das Limit ein und prüft, dass die UI die Limit-Meldung zeigt.

**Tests mit globalem Zustand** (Cron arbeitet *alle* fälligen Jobs ab, Mail-Outbox, globale Rate-Limits, Admin-Listen über alle Nutzer) laufen in einem eigenen Playwright-Projekt `serial` mit `workers: 1`, das per `dependencies` nach den parallelen Tests startet. Nur dort darf ein Test notfalls per Test-Helper gezielt `TRUNCATE … CASCADE` ausführen und neu seeden. **Nie** gibt es dafür einen Reset-Endpunkt in der App.

| Testart | Isolation |
|---|---|
| Vitest `*.db.test.ts` | Transaktion pro Test + Rollback (`tx.rollback()`, `TransactionRollbackError` abfangen) |
| E2E parallel (Normalfall) | frische DB pro Lauf + eindeutige Daten pro Test |
| E2E mit globalem Zustand | Projekt `serial`, notfalls gezielter Truncate + Seed |

### 10.5 E2E-Auswahl: Smoke und geänderte Specs

- **Smoke-Set:** handverlesen, ~20–30 Tests, je einer pro kritischer Journey, nur Normalfall, schnell und stabil. Markiert per Tag: `test("…", { tag: "@smoke" }, …)`. Beispiele für eine Reserwirt-artige App: Gast bucht bis zum Checkout, Host meldet sich an und sieht Bestellungen, Host legt ein Event an, Rechnung ist abrufbar, Kunde storniert.
- **Geänderte Specs:** `playwright test --only-changed=origin/development` führt neue und geänderte Spec-Dateien aus, inklusive Specs, deren Helper sich geändert haben. Neue oder angepasste Tests müssen so vor dem Merge grün sein.
- **Bewusste Lücke:** `--only-changed` reagiert nur auf Testdateien, nicht auf App-Code. Ein Grenzfall, den nur eine unveränderte Spec abdeckt, fällt erst im vollen Lauf nach dem Merge auf. Der lässt sich genau diesem Merge zuordnen und blockiert den Release-PR nach `main` (§11.3). Das ist der Preis für schnelle PRs.

### 10.6 Vitest-Konfiguration

Projekte `unit` (Default-Env `node`, Setup `scripts/test/unit-guard.ts`, schließt `*.db.test.ts`, `tests/integration/`, `tests/e2e/` aus), `db` (`**/*.db.test.ts`, `fileParallelism: false`, 30 s Timeout), `integration` (`tests/integration/**`, `fileParallelism: false`); Alias `server-only` → Stub; `@/` → Projektwurzel. `db` und `integration` verweigern DB-Hosts außerhalb der Allowlist (`localhost`, `127.0.0.1`, `postgres`).

---

## 11. Tooling und Qualitäts-Gates

### 11.1 `package.json`-Skripte

```jsonc
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "typecheck": "next typegen && tsc --noEmit",
  "lint": "eslint .",
  "test": "vitest run --project unit",
  "test:db": "vitest run --project db",
  "test:int": "vitest run --project integration",
  "test:e2e": "playwright test",
  "test:docker": "node scripts/test/docker.mjs tests",
  "test:e2e:docker": "node scripts/test/docker.mjs e2e",
  "verify:structure": "node scripts/structure/verify-structure.mjs",
  "verify:server-only-canary": "node scripts/structure/check-server-only-canary.mjs",
  "verify": "pnpm typecheck && pnpm lint && pnpm verify:structure && pnpm test",
  "infra:up": "docker compose up -d --wait",
  "infra:down": "docker compose down",
  "db:bootstrap": "node scripts/db/bootstrap-roles.mjs",
  "db:generate": "drizzle-kit generate",
  "db:generate:custom": "node scripts/db/generate-custom.mjs",
  "db:migrate": "node scripts/db/migrate.mjs",
  "db:seed": "node scripts/db/seed.mjs",
  "db:reset": "node scripts/db/reset.mjs",
  "db:studio": "drizzle-kit studio"
}
```

### 11.2 Keine Git-Hooks

Das Template installiert keine Git-Hooks (kein husky, lefthook, lint-staged). `pnpm verify` vor jedem PR ist eine Regel in `AGENTS.md`; durchgesetzt wird ausschließlich in der CI.

Grund: Mehrere Agenten arbeiten parallel im selben Arbeitsverzeichnis. Hooks testen den Arbeitsbaum, also auch halbfertige Änderungen anderer Agenten, und liefern falsches Rot oder Grün. Werkzeuge wie lint-staged legen ungestagte Änderungen per `git stash` beiseite; genau das hat bei Deeplify schon fremde Arbeit verschoben. Gegen versehentlich committete Secrets schützt `.gitignore` (§9).

### 11.3 CI-Pipeline

| Trigger | Jobs | Blockiert? | Dauer (Schätzung, Reserwirt-Größe) |
|---|---|---|---|
| **PR → `development`** | parallel: ① **check**: Install, Typecheck, Lint, `verify:structure`, Server-only-Canary, Unit, Build, Migrations-Drift ② **db**: `pnpm test:docker` (`*.db.test.ts` + Integration) ③ **e2e-pr**: Test-Stack mit `--grep @smoke`, danach `--only-changed=origin/development` | **Pflicht für Merge** | ~5–6 min |
| **Push auf `development`** (nach jedem Merge) | volle E2E-Suite in 4 Shards; bei Grün migrate → deploy → Deploy-Check auf Staging (§13) | Rot blockiert den nächsten Release-PR, Benachrichtigung | ~8 min + ~3 min Deploy |
| **PR `development` → `main`** und `hotfix/*` → `main` | alle Jobs + volle E2E-Suite auf dem Merge-Ergebnis (`refs/pull/N/merge`) + Prüfung, dass der Head-Commit erfolgreich auf Staging deployt ist | **Pflicht** | ~10 min |
| **Push auf `main`** (nach dem Merge) | migrate → deploy → Deploy-Check auf Production (§13); keine erneute E2E-Suite | Rot: Benachrichtigung + automatischer Rollback | ~3–4 min |
| **nachts** auf `development` | volle Suite ohne Retries und mit `--repeat-each=2` (Flaky-Suche), `pnpm audit`, Lauf mit aktualisierten Abhängigkeiten | Report | – |

Regeln:

1. **Ein Sammel-Job `ci-passed`** (`needs: [check, db, e2e…]`, `if: always()`) meldet den Gesamtstatus und ist der einzige Pflicht-Check in den Branch-Regeln. So blockieren übersprungene Jobs (z. B. per Pfadfilter bei reinen Doku-Änderungen) den Merge nicht.
2. **Migrations-Drift-Check** im check-Job: `pnpm db:generate` ausführen, dann `git diff --exit-code src/persistence/migrations`. Zusätzlich migriert der db-Job jede Runde auf einer frischen Datenbank.
3. **`actions/checkout` mit `fetch-depth: 0`** im e2e-pr-Job, sonst kennt `--only-changed` den Basis-Branch nicht.
4. **Test-Stack-Images einmal pro Workflow bauen** und über den BuildKit-Cache (`cache-from/cache-to: type=gha`) zwischen Jobs und Shards teilen. pnpm-Store und `.next/cache` werden ebenfalls gecacht.
5. **`concurrency: cancel-in-progress` nur für PRs.** Ein neuer Push bricht den veralteten PR-Lauf ab; Läufe auf `development` werden nie abgebrochen, sonst geht die Zuordnung „welcher Merge hat es kaputt gemacht“ verloren. Deploy-Jobs laufen je Umgebung in `concurrency: deploy-<environment>` mit `cancel-in-progress: false`, damit nie eine laufende Migration abgebrochen wird (§13.3).
6. **Flaky-Politik:** In der CI 2 Retries, aber jeder Flaky-Test wird im Report ausgewiesen. Wer nicht innerhalb von 24 h repariert ist, bekommt `@quarantine`: blockiert nicht mehr, hat aber ein Ticket. Retries werden nie hochgedreht, um Rot zu verdecken.
7. **Branch-Regeln aus Tablepay:** PRs nach `main` nur von `development` oder `hotfix/*` (`enforce-pr-source-branch`), `ci-passed` Pflicht auf beiden Branches.
8. **Skalierung über Shards, nicht über Worker.** Auf einem Runner teilen sich App, Postgres und Browser die CPU; mehr als ~4–6 Worker bringen dort kaum etwas.

Basis der Schätzungen: gemessene Laufzeiten beider Projekte (Deeplify Unit 10 s in CI, Integration gegen Neon 1:41 min; Tablepay Test-Schritt 2:33 min, Build 1:22 min), hochgerechnet auf ~270 Unit-Testdateien und ~400 E2E-Tests bei ~4 s pro E2E-Test. Die E2E-Zahl ist die größte Unsicherheit (±50 %).

### 11.4 ESLint (zusätzlich zu `next/core-web-vitals` + `next/typescript`)

- `no-nested-ternary: error` (Tablepay).
- `no-restricted-imports`: `modules|shared|platform|persistence` → kein `@/app/**`; `shared` → kein `@/modules/**`, kein `@/persistence/**`; überall kein `@supabase/*`, kein `@neondatabase/*` außer `src/persistence/foundation/**`.
- Der Struktur-Checker ist die Autorität für aufgelöste Pfade; ESLint gibt nur schnelles Editor-Feedback.

### 11.5 Struktur-Checker (Port aus Tablepay)

`scripts/structure/`: `verify-structure.mjs`, `structure-document.mjs` (Block-Parser), `module-graph.mjs` (Import-Auflösung inkl. `@/`-Alias), `declarations.mjs` (Narrow Entries aus READMEs), `rules/*.mjs`. Der Port ist mit ~1.600 Zeilen eine substanzielle Aufgabe (§2.7); Projekte mit vorhandenen Import-Graph-Guard-Tests bauen die Regeln stattdessen auf diesem Code auf, statt den Checker vollständig zu kopieren. Regeln im Template:

| Regel | Prüft |
|---|---|
| `roots` | nur deklarierte Wurzeln/Dateien auf Top-Level (inkl. `src/`, `tests/`, `docker/`); `src/` und `tests/` sind *governed roots*, deren direkte Kinder ebenfalls deklariert sein müssen (§3) |
| `owner-internals` | verbotene Ordnernamen, Owner-Interna privat |
| `entrypoints` | Direktiven/Marker von `index`/`client`/`server`/`actions`, keine leeren Entrypoints, Begründung für Extra-Subpaths |
| `direction` | Abhängigkeitsmatrix §4.3, transitive Client→Privileged-Sperre |
| `persistence` | Schichtränge, Seam-only-Entry, Narrow Entries, Neutral-Entrypoint-Regel, Schema-Dateien tragen einen Owner-Kopf |
| `request-services` | genau ein `cache(createRequestServices)` |
| `app-seams` | nur Next-Dateinamen unter `src/app/`, Route Handler nur unter `src/app/api/` |
| `tests` | Suffixe (`.test`, `.db.test`, `.integration.test`, `.spec` nur in `tests/e2e/`), Integrations-Taxonomie, Auflösung, Discovery |
| `documentation` | kein `docs/`, Owner-README Pflicht, Metadaten, lokale Links lösen auf |
| `env-access` **(neu, aus Deeplify)** | `process.env` nur in `src/platform/env` + erlaubten Konfig-/Skriptdateien; `DATABASE_URL_MIGRATE` nur in `scripts/db/**` + `drizzle.config.ts`; `DATABASE_URL_PUBLIC` nur in `src/persistence/foundation/**` + Skripten |
| `vendor-sdk` **(neu)** | Anbieter-SDKs nur in ihrem Platform-/Foundation-Owner |

---

## 12. Doku-Governance und Agent-Regeln

### 12.1 Dateien

| Datei | Typ | Inhalt |
|---|---|---|
| `AGENTS.md` | reference | Rolle, Workflow, Sicherheits- und Git-Regeln, Befehle, Hard Stops |
| `CLAUDE.md` | pointer | `@AGENTS.md` plus der von `next dev` verwaltete Next-Block (nicht entfernen, sonst entsteht er neu) |
| `STRUCTURE.md` | reference | Strukturpolitik + ```structure-Blöcke + Enforcement Limits |
| `DOC_RULES.md` | reference | Tablepays `PROJECT_DOC_RULES.md`, verschlankt auf eine Anwendung |
| `README.md` | reference | Zweck, Setup in 5 Befehlen, Befehlsliste, Env-Tabelle, Einstieg in Owner |
| `decisions/NNNN-*.md` | decision | ADR (`Status`, `Context`, `Decision`, `Consequences`), unveränderlich, Ablösung per neuem ADR |
| `<owner>/README.md` | reference/explanation | Public Interfaces, Tabellen (bei Modulen mit Schema), Structure & Responsibilities, Invariants, Compatibility Seams, Tests, Tradeoffs |

Jedes Dokument trägt den Metadatenkopf (vom Checker geprüft):

```md
Document type: how-to | reference | explanation | decision | tracker
Lifecycle: draft | proposed | active | needs-verification | deprecated | superseded | archived
Owner: <Owner>
Scope: <was abgedeckt ist>
Canonical responsibility: <wofür dies die aktive Quelle ist>
Maintenance triggers:
- <welche Änderung eine Überprüfung auslöst>
Last verified: <Datum + Grundlage>
```

Projektspezifische, verbindliche Entscheidungen, die bei Deeplify als nummerierte Liste in `CLAUDE.md` stehen, werden im Template ADRs unter `decisions/`; `AGENTS.md` verlinkt nur.

### 12.2 `AGENTS.md`-Gerüst (Kernregeln)

**Workflow**
1. `README.md` → `STRUCTURE.md` → nächstes Owner-README lesen.
2. Aktuelle Doku der Bibliothek holen (context7 bzw. `node_modules/next/dist/docs/`), bevor eine API genutzt wird.
3. Betroffenen Code lesen, Architektur-Auswirkung prüfen, bei nicht-trivialer Arbeit kurzen Plan bestätigen lassen.
4. Implementieren, Doku des Owners und Tests anpassen.
5. Vor „fertig“ und vor jedem PR:
   - immer `pnpm verify` (Typecheck, Lint, Struktur, Unit-Tests),
   - bei Änderungen an Schema, Repositories, Route Handlern oder Webhooks zusätzlich `pnpm test:docker`,
   - bei Änderungen an UI-Flows die betroffenen E2E-Specs im Host-Modus (`pnpm test:e2e <spec>`); neue oder geänderte Specs müssen grün sein.
6. Ergebnis berichten, inklusive nicht ausgeführter Checks.

**Tests und CI**
- Es gibt keine Git-Hooks; die CI ist das Tor. Pflicht-Checks nie umgehen, Tests nie abschwächen, überspringen oder `retries` erhöhen, um Grün zu erreichen.
- Unit-Tests ohne I/O (§10.2), E2E-Daten pro Test über Fixtures (§10.4).
- `@smoke` nur nach Absprache vergeben; das Smoke-Set bleibt klein (§10.5).
- Flaky Tests melden statt ignorieren.

**Paralleles Arbeiten (Deeplify)**
- Nur zugewiesene Dateien anfassen; fremde Änderungen im Abschlussbericht melden.
- Nie `git stash`, `git reset`, `git checkout <ref> -- …`, `git restore`, `git clean`.
- Nicht committen, wenn ein Orchestrator committet; keine parallelen Lockfile-Änderungen; keine parallelen `next build`.

**Datenbank**
- Schema ändern (in der Schema-Datei des eigenen Owners) → `pnpm db:generate`. Nie Migrationen von Hand oder per KI schreiben.
- Nur Repositories des Owners schreiben in dessen Tabellen (§5.7).
- Nie gegen nicht-lokale Datenbanken migrieren, seeden oder DDL ausführen ohne ausdrückliche Freigabe im Chat.
- Migrationskonflikte nach Prozedur §5.7.

**Struktur (Tablepay Hard Stops)**
- Keine neuen Wurzeln, kein `docs/`, kein generisches `tests/`, kein `lib/`.
- Nichts nach `src/shared/` wegen erwarteter Wiederverwendung; `src/platform/` ist kein `lib/`.
- Owner nur über öffentliche Entrypoints importieren; Client-Code erreicht nie privilegierten Code.
- Kein opportunistisches Aufräumen. Ähnliche Namen oder fehlende Referenzen sind kein Beweis; Konsumenten neu ermitteln, sonst melden statt handeln.

**Sicherheit**
- Pflicht-Review bei Auth, Autorisierung, Nutzereingaben, Webhooks, Payments, privilegiertem DB-/Provider-Code.
- Keine Secrets im Code; `.env*` außer `.env.example` nicht lesen/ändern.

**Code**
- TypeScript strict, frühe Returns, `as const`-Mengen, stabile Fehlercodes statt Text, englische Bezeichner und Doku; UI-Sprache über i18n.

---

## 13. Deployment und Betrieb

Deployt wird **ausschließlich durch die CI**. Sie migriert die Datenbank der Zielumgebung und deployt danach nach Vercel. `development` gehört zur Umgebung **Staging**, `main` zur Umgebung **Production**. Der Ablauf ist für beide identisch, nur Secrets und Vercel-Target unterscheiden sich.

### 13.1 Ablauf pro Branch

| Push auf | Schritte (nacheinander, jeder nur bei Grün des vorigen) | Umgebung |
|---|---|---|
| `development` | volle E2E-Suite im Test-Stack → **migrate** (Staging-DB) → **deploy** (Vercel `staging`) → **Deploy-Check** gegen die Staging-URL | Staging |
| `main` | **migrate** (Produktions-DB) → **deploy** (Vercel `production`) → **Deploy-Check** gegen die Produktions-URL | Production |

Auf `main` läuft die E2E-Suite nicht erneut: GitHub prüft den Release-PR auf dem Merge-Ergebnis (`refs/pull/N/merge`), also genau auf dem Stand, der nach dem Merge auf `main` liegt.

Vercel-Befehle (wie in Tablepays `vercel-deploy.yml`):

```bash
vercel pull --yes --environment=staging        # Production: --environment=production
vercel build --target=staging                  # Production: --prod
vercel deploy --prebuilt --target=staging      # Production: --prod
```

Gebaut wird pro Umgebung, weil `NEXT_PUBLIC_*` beim Build eingebacken wird und sich zwischen Staging und Production unterscheidet. Dass derselbe Code läuft, sichert der Commit, nicht ein gemeinsames Artefakt. Der CI-Build setzt `APP_COMMIT_SHA` (für den Deploy-Check). Staging ist ein Vercel Custom Environment (setzt einen Vercel-Plan mit Custom Environments voraus; Tablepay nutzt das bereits).

### 13.2 Erst migrieren, dann deployen (Expand/Contract)

Der neue Code erwartet das neue Schema, deshalb läuft die Migration zuerst. Während der Migration und bis das Deployment live ist, läuft noch der alte Code gegen das neue Schema. Migrationen sind daher immer rückwärtskompatibel:

- **Expand:** nur hinzufügen (neue Tabelle, neue Spalte nullable oder mit Default).
- **Contract:** Löschen oder Umbenennen erst in einem späteren Release, wenn kein deployter Code die Spalte mehr nutzt. Umbenennen heißt: neue Spalte anlegen, Code schreibt beide, Backfill, Code liest nur noch die neue, alte Spalte in einem späteren Release löschen.

| Situation | Folge | Reaktion |
|---|---|---|
| Migration schlägt fehl | Transaktion rollt zurück, kein Deploy, alter Code läuft unverändert | neue Migration mit Korrektur, erneut pushen |
| Migration ok, Deploy schlägt fehl | alter Code läuft gegen ein nur erweitertes Schema (unkritisch) | Deploy-Job wiederholen |
| Deploy ok, Deploy-Check rot | neuer Code läuft, ist aber falsch verdrahtet | Staging: Release blockiert; Production: Rollback (§13.5) |

Es gibt keine Down-Migrationen. Fehler werden mit einer neuen Migration behoben (fix forward).

### 13.3 Schutzmechanismen

1. **GitHub Environments `staging` und `production`** mit eigenen Secrets:

   | Secret | `staging` | `production` |
   |---|---|---|
   | `DATABASE_URL_MIGRATE` | Owner-URL der Staging-DB (direkt, kein Pooler) | Owner-URL der Produktions-DB (direkt, kein Pooler) |
   | `MIGRATE_EXPECTED_HOST` | Hostname der Staging-DB | Hostname der Produktions-DB |
   | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | dasselbe Vercel-Projekt, Target `staging` | dasselbe Vercel-Projekt, Target `production` |

2. **Deployment-Branch-Regel:** Das Environment `production` darf nur von `main` genutzt werden, `staging` nur von `development`. Ein Workflow auf einem anderen Branch kommt nicht an diese Secrets. Für Production kann zusätzlich eine manuelle Freigabe (Required Reviewers) verlangt werden.
3. **Nie abbrechen:** Deploy-Jobs laufen in `concurrency: deploy-<environment>` mit `cancel-in-progress: false`. Tablepay hat hier `true`; ohne Migrationen harmlos, mit Migrationen gefährlich, weil ein neuer Push eine laufende Migration abschießen würde. Der Advisory Lock im Migrations-Runner ist die zweite Absicherung.
4. **Zieldatenbank bestätigen:** `pnpm db:migrate --remote --expect-host=$MIGRATE_EXPECTED_HOST` bricht ab, wenn der Host der URL nicht exakt dem erwarteten entspricht. Ein vertauschtes Secret migriert so nie die falsche Datenbank (§5.7).
5. **Rollentrennung:** Migriert wird mit der Owner-Rolle über die direkte Verbindung; die Laufzeit-Rolle `app_runtime` migriert nie (§5.8).
6. **Nur die CI deployt:** Vercels Git-Auto-Deploy ist aus (`"git": { "deploymentEnabled": false }` in `vercel.json`, wie bei Tablepay). Die Laufzeit-Variablen (`DATABASE_URL`, `DATABASE_URL_PUBLIC`, `BETTER_AUTH_SECRET`, …) liegen weiterhin pro Umgebung in Vercel; die CI braucht nur den Vercel-Token und die Migrations-URL.

### 13.4 Deploy-Check

Der Deploy-Check ist **nicht** das E2E-Smoke-Set:

| | E2E-Smoke (`@smoke`, §10.5) | Deploy-Check |
|---|---|---|
| Frage | Funktioniert die App fachlich? | Ist dieses Deployment richtig verdrahtet? |
| Läuft gegen | Docker-Test-Stack mit Wegwerf-DB | die echte Umgebung (Staging bzw. Production) |
| Werkzeug | Playwright, Login, schreibt Daten | `scripts/deploy/check.mjs <url>` mit `fetch`, ~10 s |
| Schreibt Daten? | ja | **nie**, auch nicht auf Staging |

Fachliche Tests laufen also nie gegen echte Datenbanken. Der Deploy-Check liest ausschließlich und ist für beide Umgebungen identisch, nur die URL unterscheidet sich. Er wartet nach dem Deploy bis zu 60 s auf eine erste gesunde Antwort und prüft dann:

1. **`GET /api/health` liefert 200.** Der Endpunkt (`src/app/api/health/route.ts` → `getRequestServices().system.health()`, Use Case `system-use-cases.ts`, Repository `system-repository.ts`) prüft serverseitig:
   - die App-Version entspricht `APP_COMMIT_SHA` des gerade deployten Commits,
   - die DB ist mit der Laufzeit-Rolle erreichbar (`select 1`),
   - die zuletzt angewendete Migration in der DB entspricht der letzten Migration im Build (die Laufzeit-Rolle bekommt dafür per Custom-Migration Leserecht auf Drizzles Migrationstabelle).

   Nach außen liefert er nur `{ ok, version }` (bzw. 503), keine Details über die Infrastruktur.
2. **`/` und `/login` liefern 200** und enthalten ein erwartetes Element: Rendering und Build-Variablen stimmen.
3. **`/dashboard` ohne Cookie leitet auf `/login` um:** Proxy und Auth-Verdrahtung funktionieren.

Warum er nötig ist, obwohl alle Tests grün sind: Der Test-Stack sieht die echte Umgebung nicht. Typische Fehler, die nur dort auftreten: fehlende oder falsche Env-Variablen in Vercel, fehlende Rechte der Laufzeit-Rolle auf der echten DB (etwa weil Rollen in der Anbieter-Konsole anders angelegt wurden), eine Migration gegen eine andere DB als die, auf die das Deployment zeigt, ein `NEXT_PUBLIC_*`-Wert der falschen Umgebung.

Derselbe Endpunkt dient dem Test-Stack als Healthcheck und kann von einem externen Uptime-Monitor genutzt werden.

### 13.5 Rollback und Fehlerreaktion

- **Staging rot** (E2E, Migration, Deploy oder Deploy-Check): Benachrichtigung. Der Release-PR nach `main` enthält einen Job, der prüft, dass sein Head-Commit erfolgreich auf Staging deployt wurde (GitHub-Deployment-Status `success`); solange das nicht der Fall ist, ist der Release blockiert.
- **Production rot:** Benachrichtigung und automatischer Rollback auf das vorherige Deployment (`vercel rollback` im Workflow, entspricht Vercels Instant Rollback). Das Schema bleibt stehen, was dank Expand/Contract unkritisch ist. Die Korrektur kommt als Hotfix.

### 13.6 Hotfixes, Previews, Betrieb

- **Hotfix:** `hotfix/*` → PR nach `main` (volle Pipeline) → Production-Deploy. Danach wird `main` zurück nach `development` gemergt, sonst überschreibt der nächste Release den Fix oder die Migrationshistorien laufen auseinander.
- **Keine Preview-Deploys pro PR.** Ein Preview bräuchte eine eigene DB mit den PR-Migrationen: Die Staging-DB zu teilen hieße, ungemergte Migrationen auf Staging anzuwenden; eine DB pro PR geht praktisch nur mit Anbieter-Branching (Neon) und widerspricht der Anbieterunabhängigkeit. PRs prüft der Docker-Test-Stack, Staging ist die gemeinsame Vorschau.
- **Vercel und Commit-Autor:** Bei Deeplify blockiert Vercel Deployments, deren Commit-Autor nicht im Vercel-Team ist; dort wird deshalb per `git archive` ohne Git-Metadaten deployt. Beim Einrichten der CI früh testen; tritt es auf, braucht der Deploy-Schritt denselben Umweg.
- **Cron:** `vercel.json` `crons`; laufen nur in Production. Vercel ruft die Deployment-URL auf; Cron-Routen authentifizieren selbst und dürfen nicht an Host-Guards scheitern (Deeplify-Lehre).
- **Deployment Protection:** `*.vercel.app` geschützt, Custom Domains öffentlich.
- **Region:** Vercel-Functions-Region = DB-Region.
- **Observability:** Sentry-Release pro Deploy (Source Maps im Build), strukturierte Logs ohne personenbezogene Daten (IP nur gehasht mit Salt, wie Deeplifys Checker).

---

## 14. Rezepte (Bausteine außerhalb des Template-Kerns)

Jedes Rezept ist ein benannter Owner mit README, Env-Einträgen, Tests und einem ADR bei Aktivierung.

| Rezept | Owner | Kern |
|---|---|---|
| Datei-Speicher | `src/platform/object-storage` | S3-Client, Bucket-/Pfad-Konventionen, Scope-Prüfung pro Mandant, Presigned URLs; MinIO in `docker/compose.yml` und `docker/compose.test.yml`. Einziger Halter der Storage-Credentials (Tablepay-Regel) |
| Jobqueue | `src/platform/jobs` + Tabelle `jobs` | `kind`, `payload jsonb`, `run_at`, `attempts`, `locked_until`; Claim per `select … for update skip locked` (Drizzle `.for("update", { skipLocked: true })`), Lease, Backoff; Cron-Route arbeitet ab; Outbox für Mails |
| Rate-Limit öffentlicher Endpunkte | `src/platform/rate-limit` | Postgres-Tabelle mit Fenstern, IP nur als `sha256(ip + salt)` |
| SSRF-sicherer Fetch | `src/platform/safe-fetch` | undici-Agent mit `lookup`, der private/Loopback/Link-Local/CGNAT/ULA/Multicast zur Verbindungszeit ablehnt (Deeplify) |
| Payments | `src/platform/stripe-client` + Modul `billing` | generische Signaturprüfung in Platform, Bedeutung eines Zahlungsereignisses im Modul (Tablepay-Trennung) |
| PDF | `src/shared/pdf` bzw. Modul | React-PDF serverseitig |
| Analytics + Consent | `src/platform/analytics`, `src/platform/consent` | PostHog EU über `/ingest`-Rewrite, cookielos bis Consent (Klaro); Produkttexte behaupten dann nie „no tracking“; im Test-Stack immer aus |
| Mandanten | Modul `workspaces` + `src/platform/access` | Tabellen `workspace`, `membership(role)`, Einladungen per Magic Link |
| Mobile-/Partner-API | `src/platform/api-access` | Bearer/JWT via Better Auth, versionierte Routen unter `src/app/api/v1/`, Verträge in `tests/integration/compatibility/` |
| Blog / Content | Modul `blog` | Markdown in `content/`, zur Build-Zeit gerendert (Deeplify) |

---

## 15. Übernahme-Matrix

| Element | Tablepay | Deeplify | Template |
|---|---|---|---|
| Owner-Modell `modules/shared/platform/persistence` | ✔ | – | ✔ übernommen |
| `STRUCTURE.md` + Checker | ✔ | – | ✔ portiert, + `env-access`, `vendor-sdk`, `e2e` |
| Guard-Tests (Import-Graph, Env-Namen) | – | ✔ | ✔ als Checker-Regeln |
| Repositories + Use Cases + Composition Root | ✔ | – | ✔ mit Contracts-Trennung und Repos-reichender UoW |
| DB-Zugriff | Drizzle + postgres-js, Supabase | rohes SQL, Neon HTTP | Drizzle + `pg`, beliebiger Postgres |
| Schema-Ort | zentral, grob nach Fachgebiet (`app_schema.ts` …) | SQL-Migrationen | zentral, eine Datei pro Owner, nur der Owner schreibt |
| Migrationen | drizzle-kit → `supabase/migrations` | handgeschrieben + eigener Runner | drizzle-kit → `src/persistence/migrations`, eigener Runner mit Lock + Prod-Schutz, Drift-Check in CI |
| DB-Rollen | eine URL (Owner-nah) | 4 Rollen + RLS | 3 Rollen Standard (`app_owner`/`app_runtime`/`app_public`), RLS als Rezept |
| Auth | Supabase OTP | Better Auth Magic Link (Kysely) | Better Auth Magic Link (Drizzle-Adapter) |
| Autorisierung | Rollen → Rechte-Bündel | RLS / Besitz | Rechte-Bündel + Scope-ID in jeder Repo-Methode |
| API-Pipeline + `{errorCode}` | ✔ | – | ✔ |
| Fehlercodes statt Text | ✔ | ✔ (SQLSTATE-Kinds) | ✔ beides |
| i18n | next-intl de/en | nur Englisch, Guard „no German“ | next-intl, zunächst eine Sprache |
| Mail | Resend + React Email | nodemailer SMTP + Mailpit | nodemailer SMTP + React Email + Mailpit |
| Storage | Supabase Storage | – | S3-Rezept |
| Lokale DB | Supabase lokal | Neon `dev`-Branch | Docker Postgres 18 |
| Unit-Tests | Mocks (`vi.fn`, `as never`) | Fakes injiziert | typisierte Fakes, I/O zur Laufzeit blockiert |
| DB-Tests | Mocks | pgTAP + Integration gegen `dev` | `*.db.test.ts` im Docker-Test-Stack (pgTAP nur bei SQL-Logik) |
| E2E | – | Playwright + Mailpit, lokal gegen `dev`-Branch | Playwright im Docker-Test-Stack; PR: Smoke + geänderte Specs, voll nach Merge |
| CI | Typecheck, Lint, Struktur, Test, Build | check + db gegen Neon `dev` | check ∥ db ∥ e2e im Test-Stack, Sammel-Job `ci-passed` |
| Deployment | GitHub Actions, `vercel deploy --prebuilt` pro Umgebung; Migrationen manuell | manuell per CLI (`git archive`); Migrationen manuell | nur CI, pro Umgebung: migrate → deploy → Deploy-Check, Rollback bei Rot |
| Git-Hooks | – | – | keine; CI als einziges Tor |
| Doku-Governance | ✔ ausführlich | CLAUDE.md-Entscheidungsliste | Tablepay-Governance + ADRs in `decisions/` |
| Parallel-Agent-Regeln | teilweise | ✔ | ✔ |
| Paketmanager | npm | pnpm | pnpm |
| Observability | Sentry | PostHog | Sentry Kern, PostHog Rezept |

---

## 16. Offene Entscheidungen (mit Empfehlung)

| Frage | Empfehlung | Begründung |
|---|---|---|
| Einzel-App oder pnpm-Workspace (`apps/web`, `apps/website`)? | **Einzel-App**, Marketing als Route-Group | Deeplify zeigt, dass Marketing + App in einem Deployable gut funktioniert; Workspace erst bei eigenem Lebenszyklus (Tablepay-Website) |
| RLS ab Tag 1? | **Nein**, aber drei Rollen (inkl. `app_public` für unauthentifizierte Pfade) + Scope-ID-Regel | Komplexität erst, wenn mehrere Schreibpfade auf sensible Mandantendaten zugreifen |
| next-intl mit oder ohne Routing? | **Ohne** Routing, eine Locale | Texte sind trotzdem externalisiert; Routing später ohne Umbau der Komponenten |
| Base UI oder Radix unter shadcn? | **Base UI** | aktueller Stand in Deeplify; einmal festlegen, nie mischen |
| Mandanten im Kern oder als Rezept? | **Rezept** | Deeplify ist Einzelnutzer, Tablepay mandantenfähig; das Beispielmodul `projects` ist nutzergebunden |
| Node 22 oder 24? | **24 LTS**, maßgeblich aus `.nvmrc` für Hosting/CI/Docker, lokal per `engines.node`-Bereich freier | aktives LTS; Vercel-Runtime und Docker-Images gleich einstellen, Upgrade auf die nächste LTS immer gemeinsam in einem Commit |
| Treiber `pg` oder `postgres`? | **`pg`** | Pooler-kompatibel ohne Sonderoptionen, gleicher Treiber für Better Auth, Migrationen, Tests |
| Runner-Größe in der CI | Standard-Runner + 4 E2E-Shards | größere Runner nur, wenn die Wartezeit nach Merges stört |

Entschieden (Revision 2): Schema zentral mit einer Datei pro Owner; Tests im Docker-Test-Stack; keine Git-Hooks; PR-Pipeline mit Smoke + geänderten Specs, volle Suite nach Merge und vor `main`.

Entschieden (Revision 3): Deployment nur durch die CI, Migration vor dem Deploy mit Expand/Contract, lesender Deploy-Check pro Umgebung, automatischer Rollback in Production, keine Preview-Deploys.

Entschieden (Revision 4): dritte DB-Rolle `app_public` für unauthentifizierte öffentliche Pfade, eigene URL, eigener Pool, eigene Composition-Naht; Node-Version verbindlich aus `.nvmrc` für Hosting/CI/Docker, lokal per `engines.node`-Bereich freier; Struktur-Checker realistisch mit ~1.600 Zeilen bewertet, Alternative über bestehende Import-Graph-Guard-Tests; Better-Auth-Rate-Limits gelten nur im HTTP-Router, ratenbegrenzte Auth-Endpunkte aus Server Actions über `getAuth().handler()`; Docker-Test-Stack mit C-Collation, initdb-Rollen und nicht-superuser Migrations-Owner, Migrate-Job seedet immer mit; E2E-Session-Helfer setzt beide Cookie-Varianten.

---

## 17. Umsetzungsplan für das Template

1. **Gerüst:** `create-next-app` (TS, Tailwind, ESLint, App Router), pnpm, `.nvmrc`, `tsconfig` (`@/*`), `AGENTS.md`/`CLAUDE.md`/`README.md`, `STRUCTURE.md` mit `roots`-Block.
2. **Infrastruktur lokal:** `docker/compose.yml` (Postgres 18 auf projekteigenem Port, Mailpit), `scripts/db/*` (bootstrap-roles, migrate, seed, reset), `drizzle.config.ts`, `src/platform/env`.
3. **Persistence:** `foundation/`, `schema/` (`auth.ts` + erste Owner-Datei), Contracts, Drizzle-Repositories, UoW, Composition Root, erste generierte Migration + Grant-Custom-Migration.
4. **Auth:** Better-Auth-Schema generieren, `src/platform/auth`, `src/platform/mailer`, `src/modules/sign-in`, `src/proxy.ts`, `(app)/layout.tsx`, `src/app/api/health`.
5. **Struktur-Checker portieren** (substanzielle Aufgabe, ~1.600 Zeilen, §2.7): Tablepays `scripts/structure` kopieren, Wurzeln/Pfade anpassen, neue Regeln `env-access`, `vendor-sdk`, `e2e`, Owner-Kopf der Schema-Dateien; Fixture-Tests für jede Regel. Projekte mit vorhandenen Import-Graph-Guard-Tests bauen die Regeln stattdessen auf diesem Code auf, statt den Checker vollständig zu kopieren.
6. **Test-Stack:** `docker/app.Dockerfile`, `docker/e2e.Dockerfile`, `docker/compose.test.yml`, `scripts/test/docker.mjs`, `scripts/test/unit-guard.ts`, Vitest-Projekte, Playwright-Config mit Projekt `serial`, E2E-Helper (Fixtures, Factories, Test-Session, Mailpit) samt Guard-Test für die Test-Session.
7. **Beispielmodul `projects`:** vertikaler Schnitt (§5.6) mit Unit-Test (Fakes), `*.db.test.ts`, E2E-Spec und einem `@smoke`-Test als Kopiervorlage.
8. **API-Pipeline + Cron-Beispiel:** Port aus Tablepay, eine Cron-Route mit `CRON_SECRET`, ein Integrationstest.
9. **UI-Basis:** shadcn-Init nach `src/shared/ui-primitives`, Token-Set, Layouts, `loading`/`error`-Konventionen, Security-Header + E2E-Check.
10. **CI + Deploy:** `ci.yml` nach §11.3 (check ∥ db ∥ e2e-pr, volle Suite auf `development` und vor `main`, nachts), Deploy-Workflow nach §13 (GitHub Environments `staging`/`production` mit Secrets und Branch-Regel, migrate → deploy → Deploy-Check, Rollback), `/api/health` + `scripts/deploy/check.mjs`, Branch-Regeln mit `ci-passed`, Vercel-Projekt mit Custom Environment `staging` und abgeschaltetem Git-Auto-Deploy, Sentry. Früh testen, ob Vercel Deploys wegen des Commit-Autors blockiert (§13.6).
11. **Rezepte** nach Bedarf, jeweils mit ADR.

---

## 18. Revision 5: Erfahrungen aus der Deeplify-Migration

Deeplify wurde vollständig von seiner ursprünglichen Neon/Supabase-Architektur auf dieses
Template umgebaut (Branch `template-migration`, Tasks P3-0 bis P3-8). Dieser Abschnitt hält
konkrete, umsetzbare Ergänzungen aus dieser Migration fest - jede mit dem Abschnitt, den sie
ändert, und der Begründung. Der volle Abschlussbericht der Migration selbst steht in
Deeplifys `decisions/0035-template-migration-complete.md`, nicht hier.

- **§12 Doku-Governance: Doku-Orte gehören in den Auftrag, nicht nur in die Regel.**
  Ein Agent-Auftrag, der "Dokumentation ergänzen" verlangt, ohne den Zielort zu nennen,
  erzeugt zuverlässig `docs/` - selbst wenn `AGENTS.md`/`DOC_RULES.md` das Verbot
  unmissverständlich festhalten (bei Deeplifys Deploy-Vorbereitung geschehen: ein Agent
  legte `docs/deployment.md` an, musste danach nach `scripts/deploy/README.md`
  verschoben werden). Der Checker (§11.5) fängt das erst nach dem Schreiben ab, nicht
  vorher. Ergänzung: jeder Auftrag, der neue oder materiell umgeschriebene Dokumentation
  verlangt, nennt den exakten Zielpfad (bestehende Owner-`README.md`, ein bestehendes ADR,
  oder explizit "neues ADR unter `decisions/NNNN-*.md`") statt nur "dokumentieren".

- **§10.3 Docker-Test-Stack: Ressourcenbudget und Hang-Workaround bei parallelen
  Worktree-Agenten.** Mehrere gleichzeitige Worktree-Agenten, jeder mit eigenem
  `compose.test.yml`-Projekt (eigener Name z. B. aus einem Pfad-Hash, damit sie sich nicht
  in die Quere kommen), akkumulieren schnell Images und Build-Cache - bei Deeplify zweimal
  eine Festplatten-Krise (98-100 % voll, Docker Desktop mit `containerd`-I/O-Fehlern
  hängend) mit nötigem Nutzer-Eingriff (Docker-Neustart erzwingen, `docker builder prune -af`
  plus `docker image prune -af`, ungetrackte Build-Reste löschen). Ergänzung: ein
  dokumentiertes Ressourcenbudget (z. B. "min. 15 GB frei, sonst stoppen und den Nutzer
  fragen" - Deeplifys eigener Agent-Auftrag hat das inzwischen als harte Regel) und ein
  dokumentierter Recovery-Schritt (Docker-Neustart + Prune-Befehle) gehören in §10.3, nicht
  nur in projektspezifische Agent-Regeln.

- **§17 / Werkzeug-Ebene: Subagenten und Hintergrund-Befehle.** Ein Subagent, der einen
  langlaufenden Befehl in den Hintergrund schickt (statt ihn im Vordergrund laufen zu
  lassen), bekommt dessen Ergebnis nie zuverlässig mit - der Prozess läuft weiter, aber der
  Agent selbst wacht nicht wieder auf und der Status "running" beweist keinen Fortschritt
  (bei Deeplify wiederholt beobachtet: ein Agent stand über eine Stunde still, ohne
  Dateiänderung, ohne laufenden Prozess). Ergänzung: jeder Auftrag an einen Subagenten mit
  potenziell langlaufenden Befehlen (Migrationen, volle Testsuiten, Docker-Builds) verlangt
  explizit Vordergrund-Ausführung mit großzügigem, expliziten Timeout, statt sich auf den
  Default zu verlassen; bei mehreren parallelen Agenten braucht jeder einen eigenen
  Fortschritts-Watcher (letzte Dateiänderung/laufende Prozesse), nicht nur einen Status-Poll.

- **§2.7/§11.5 Struktur-Checker: `tsx` als Laufzeit, `roots` nur gegen von Git verfolgte
  Pfade.** Der Checker ist reines TypeScript ohne eigenen Build-Schritt - `tsx` ist damit
  keine optionale Dev-Dependency, sondern eine Laufzeitvoraussetzung von
  `pnpm verify:structure`, das sollte §11.5 explizit nennen. Wichtiger: die `roots`-Regel
  (§4) darf niemals ein rohes Verzeichnis-Listing gegen die deklarierten Wurzeln prüfen -
  das flaggt jedes gitignorte Build-/Test-Artefakt (`.next/`, `.vercel/`,
  `test-results/`, ein lokal vorhandenes `.env.local`) als Verstoß, obwohl ein frischer
  CI-Checkout sie nie enthält. Ergänzung: die Regel muss gegen die von Git verfolgten
  Top-Level-Einträge prüfen (`git ls-tree` bzw. äquivalent), mit einem Fallback auf das
  Dateisystem nur außerhalb eines Git-Arbeitsverzeichnisses.

- **§9 Konfiguration: `rawServerEnv()` als injizierbarer Default neben der
  Zod-validierten `serverEnv()`.** §9 verlangt zu Recht, dass jede serverseitige
  Konfiguration durch eine zentrale, Zod-validierte Stelle läuft. In der Praxis nehmen
  mehrere Kern-Module (z. B. Deeplifys `platform/mailer/core/env.ts`) ihre Konfiguration
  aber als injizierbaren Funktionsparameter mit `process.env`-Default entgegen (z. B.
  `readSmtpConfig(env = process.env)`), damit Unit-Tests einen Fake ohne Zod-Overhead
  durchreichen können, ohne das Modul an ein Test-Double für die zentrale Env-Stelle zu
  koppeln. Das ist eine bewusste, begründete Abweichung von "nur über die zentrale Stelle
  lesen", keine Umgehung: die zentrale Stelle (`platform/env`) liefert intern trotzdem das
  validierte Ergebnis, `rawServerEnv()` ist nur der Default-Wert für den injizierbaren
  Parameter. Ergänzung: §9 sollte dieses Muster (validierte zentrale Funktion plus
  injizierbarer `env`-Parameter mit demselben Live-Objekt als Default) explizit als
  zulässige Variante nennen, inklusive der Checker-Regel, die trotzdem jeden direkten
  `process.env`-Zugriff außerhalb der erlaubten Dateien flaggt (nicht nur benannte
  Variablennamen, sondern jedes Vorkommen von `process.env` im Quelltext).

- **§13.2 Erst migrieren, dann deployen: die frische Datenbank als dritte Option.**
  §13.2 beschreibt Expand/Contract für inkrementelle Schemaänderungen. Ein Umbau, der das
  Rollenmodell selbst ersetzt (bei Deeplify: vier Neon-Rollen mit RLS → drei Rollen ohne
  RLS, Autorisierung im Anwendungscode, `decisions/0002`) lässt sich damit nicht sauber
  inkrementell fahren - zu viele Objekte (Rollen, Policies, `security definer`-Funktionen)
  müssten während der Übergangszeit in zwei Formen gleichzeitig existieren. Ergänzung:
  §13.2 sollte als dritte, explizit benannte Option die frische Zieldatenbank nennen (neue
  Datenbank/neuer Branch mit dem Zielschema von Anfang an, einmaliger Datenexport/-import,
  die alte Datenbank bleibt als Rollback bestehen) - für den Fall, dass sich Rollen-/
  Schemamodell grundlegend ändert, nicht nur einzelne Tabellen/Spalten.

- **§13.6 Vercel-Commit-Autor-Block: `git archive`-Deploys als Standardmuster.** §13.6
  erwähnt den Commit-Autor-Block bereits als Punkt, den man früh testen sollte. Deeplifys
  konkrete Erfahrung: Vercel lehnt eine Deployment ab, deren Commit-Autor nicht Mitglied
  des Ziel-Teams ist (der CI-Service-Account ist es typischerweise nicht) - unabhängig
  davon, wer den Deploy tatsächlich auslöst. Die funktionierende Umgehung: den exakten
  Commit ohne `.git`-Metadaten archivieren (`git archive <sha> | tar -x`) und `vercel
  build`/`vercel deploy --prebuilt` aus diesem sauberen Verzeichnis heraus laufen lassen -
  Vercel sieht dann keinen Commit-Autor mehr, gegen den es prüfen könnte. Ergänzung: §13.6
  sollte dieses Muster als Standardlösung nennen, nicht nur als zu testendes Risiko.

- **§10 Teststrategie: Erfahrungen beim Retirement einer bestehenden pgTAP-Suite.**
  Für ein Projekt, das (wie Deeplify) mit pgTAP statt der in §10.3 beschriebenen
  Vitest-Integrationstests startet, ist der sichere Übergang: jede pgTAP-Datei einzeln auf
  eine oder mehrere neue `tests/integration/*.test.ts`-Dateien abbilden (nicht die ganze
  Suite auf einmal), bei jeder Abbildung eine 1:1-Tabelle "pgTAP-Assertion → TS-Test"
  führen, und die pgTAP-Datei erst löschen, nachdem ihre komplette Abdeckung nachweislich
  im neuen Test existiert. Ergänzung: §10 sollte diesen Ablauf als Migrationspfad für
  bestehende pgTAP-Projekte nennen, mit dem Hinweis, dass die Abbildungstabelle im
  Migrations-ADR landet (bei Deeplify: `persistence/README.md` §4a), nicht nur in einer
  Commit-Message.

- **§13.1 Staging als Vercel-Preview-Deployment plus Alias statt Custom Environment.**
  §13.1 setzt ein Vercel Custom Environment für Staging voraus, was einen entsprechenden
  Vercel-Plan verlangt. Deeplifys tatsächliche Umsetzung (`decisions/0034`, die
  `decisions/0029`s Custom-Environment-Ansatz insofern ablöst): ein normales Preview-
  Deployment für den `development`-Branch, dem eine stabile Alias-Domain
  (`staging.<host>`) zugewiesen wird, mit denselben Deploy-Schritten (migrate → deploy →
  Deploy-Check) wie Production. Ergänzung: §13.1 sollte diese Variante als gleichwertige,
  planunabhängige Alternative nennen, nicht nur das Custom Environment.

- **§11.3 CI-Pipeline: `workflow_run` braucht einen eigenen `push`-Trigger auf dem
  beobachteten Branch.** Ein Deploy-Workflow, der per `workflow_run` auf den Abschluss der
  CI-Pipeline für `main` wartet, löst nie aus, wenn `ci.yml` selbst keinen `push`-Trigger
  auf `main` hat - ein Merge-PR allein erzeugt dort keinen abgeschlossenen CI-Lauf, den
  `workflow_run` beobachten könnte (Pull-Request-Läufe laufen auf dem Merge-Ref, nicht auf
  `main` selbst). Ergänzung: §11.3 sollte explizit festhalten, dass jeder Branch, den ein
  `workflow_run`-Trigger beobachtet, auch einen `push`-Trigger auf `ci.yml` selbst braucht.

- **§13 Deployment: `vercel env pull` liefert nicht jeden als "Sensitive" markierten
  Wert zurück.** Ein Setup-Skript, das Production-Env-Werte nach Preview/Staging
  spiegeln will, kann sich nicht darauf verlassen, dass `vercel env pull` jeden
  angeforderten Wert tatsächlich liefert - als "Sensitive" markierte Werte kommen je nach
  Vercel-Plan/-Konfiguration leer zurück. Ergänzung: ein solches Skript muss den
  leeren/fehlenden Fall explizit behandeln (überspringen + Hinweis "von Hand setzen"),
  statt einen leeren String als gültigen Wert zu übernehmen; §13 sollte diese Einschränkung
  nennen, wo es `vercel env pull` für ein Setup-Skript vorschlägt.
