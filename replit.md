# Textbook Access Portal

Processes accessible textbook requests, searches multiple sources, assigns books to students, and stores uploaded files.

## Run & Operate

- `pnpm run typecheck` — Typecheck all packages
- `pnpm run build` — Typecheck and build all packages
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks and Zod schemas
- `pnpm --filter @workspace/db run push` — Push DB schema changes (development only)
- `pnpm --filter @workspace/api-server run dev` — Run API server locally
- `pnpm --filter @workspace/textbook-portal run dev` — Run Textbook Access Portal locally
- `cd services/disambiguation && pytest` — Run disambiguation engine tests
- `cd services/disambiguation && python -m uvicorn app.main:app --port 8090` — Run disambiguation FastAPI service locally

**Environment Variables:**
- `TEXTBOOK_LIBRARY_PATH`: Path to a local filesystem library for textbook searching.
- `TEXTBOOK_LIBRARY_MAX_FILE_MB`: Maximum file size for filesystem library (default 200).
- `LIBRARY_BRIDGE_TOKEN`: Bearer token for the library bridge.
- `JOTFORM_SHEET_TABS`: Comma-separated list of Google Sheet tabs to poll (e.g., "Tab A,Tab B").
- `ATPC_USERNAME`, `ATPC_PASSWORD`, `ATPC_STUDENT_ID`, etc.: Credentials and defaults for ATPC order automation.
- `SPEECHIFY_API_KEY`: API key for Speechify integration.
- `DISAMBIGUATION_DATABASE_URL`: Database URL for the disambiguation service (defaults to SQLite).
- `ADMIN_EMAIL`: Email address for admin notifications.

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API**: Express 5
- **Frontend**: React + Vite
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (v4), drizzle-zod
- **API Codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild
- **Auth**: Clerk
- **Storage**: Replit object storage

## Where things live

- **Textbook Portal Frontend**: `artifacts/textbook-portal`
- **API Server**: `artifacts/api-server`
- **Main API Routes**: `artifacts/api-server/src/routes/textbookPortal.ts`
- **Storage Routes**: `artifacts/api-server/src/routes/storage.ts`
- **DB Schema**: `lib/db/src/schema/textbookPortal.ts`
- **API Contract**: `lib/api-spec/openapi.yaml`
- **Disambiguation Engine**: `services/disambiguation/`
- **Email Templates**: `services/disambiguation/templates/`

## Architecture decisions

- **Prioritized Search Cascade**: Textbook searches follow a strict priority: local DB uploads > filesystem library > Open Textbook Library > atpc.net > Bookshare.
- **Single-Tab Google Sheets Polling**: By default the poller watches **only the "Jotform Automation" tab** — the one JotForm is configured to write into. Historical per-term tabs ("Spring 2024", "Fall 2025", ...) hold already-completed work and would re-trigger operator emails if polled. To opt extra tabs back in, set `JOTFORM_SHEET_TABS="Tab A,Tab B"` (comma-separated). `listSheetTabs` is exported in `connectors.ts` for ad-hoc discovery scripts but is no longer called automatically.
- **Fuzzy Header Matching**: `buildPayloadFromSheetRow` still uses fuzzy header matching (any header containing `email` → email; `firstname`/`lastname` or fallback `studentname`/`name` → studentName; `title`/`booktitle`/`title#N`/`bookNtitle` → titles; any header containing `isbn` → ISBNs) so any new tab with the JotForm shape works without code changes if it's added via `JOTFORM_SHEET_TABS`.
- **ATPC Search/Order Automation**: Includes complex workarounds for ATPC's search limitations (substring matching, punctuation sensitivity, keyword ranking) and fully automates the order placement process via Playwright.
- **Disambiguation Service**: A standalone Python/FastAPI service handles fuzzy matching decisions, logging all choices and allowing human overrides, accessible via API proxy.

## Product

- **Request Processing**: Ingests textbook requests from JotForm.
- **Multi-Source Search**: Searches local database, filesystem, and external services (Open Textbook Library, atpc.net, Bookshare).
- **Book Assignment**: Assigns found books to students and stores associated files.
- **Student Library**: Provides a portal for students to access their assigned books.
- **Admin Dashboard**: Offers an overview of requests, monthly statistics, and activity feeds.
- **Manual Request Creation**: Allows administrators to manually create new requests.
- **Book Management**: Functionality for uploading, searching, and managing books.
- **JotForm Webhook & Google Sheets Integration**: Integrates with JotForm for request submission and polls Google Sheets for additional requests.
- **Automated Notifications**: Sends notifications (e.g., via Gmail) for various events.

## User preferences

- _Populate as you build_

## Gotchas

- **ATPC Credentials**: Trailing whitespace in `ATPC_USERNAME` or `ATPC_PASSWORD` will cause silent login failures during ATPC order automation.
- **ATPC Search Nuances**: ATPC's search is punctuation-sensitive and has a 50-row limit, requiring specific title cleaning and multi-query strategies.
- **Disambiguation Thresholds**: Automatic matching and review floors are governed by specific confidence thresholds (e.g., auto-accept ≥85).
- **Filesystem Library**: Files larger than `TEXTBOOK_LIBRARY_MAX_FILE_MB` are skipped.
- **Old Sendgrid Secret**: The `SENDGRID_API_KEY` secret is deprecated and no longer used; it can be removed.

## Pointers

- [pnpm-workspace skill](https://www.replit.com/talk/workspace/pnpm-workspace-skill)
- [Replit Object Storage Documentation](https://docs.replit.com/hosting/object-storage)
- [Clerk Documentation](https://clerk.com/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs)
- [Zod Documentation](https://zod.dev/)
- [Orval Documentation](https://orval.dev/)