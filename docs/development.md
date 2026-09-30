# Development

## Setup

```sh
npm ci
npm run dev
```

Open http://localhost:5178. The first time, Relay walks you through setup and creates your administrator account. `npm run dev` runs the API on port 3090 with automatic restarts, Vite with hot reload on port 5178, which proxies API calls, and the direct-transfer helper on UDP port 3090, so this machine's browsers get direct transfers. Local data goes to `.data/`. Delete that folder to start over.

Relay needs Node.js 24, which can run TypeScript directly, so there's no compile step. The project pins Node 24 as a dev dependency, and every npm script runs on it even when your system has an older Node. To run a file directly, use `npx node <file>`.

## Commands

| Command                           | What it does                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev`                     | API and Vite dev server with reload                                                       |
| `npm run build`                   | Type-checks everything and builds the web app into `dist/`                                |
| `npm run check`                   | Formatting, type-check, lint and backend tests: the same checks as CI                     |
| `npm run typecheck`               | TypeScript, without building                                                              |
| `npm run lint` / `lint:fix`       | ESLint                                                                                    |
| `npm start`                       | Runs the production server, which serves `dist/`                                          |
| `npm test`                        | Backend integration tests on disposable instances                                         |
| `npm run test:e2e`                | Builds, then runs the browser journeys in Chromium, Firefox, WebKit and a mobile viewport |
| `npm run format` / `format:check` | Prettier                                                                                  |
| `npm run screenshots`             | Regenerates `docs/images` from generated demo content. Run `npm run build` first.         |

Install the browsers once before the first end-to-end run:

```sh
npx playwright install --with-deps
```

## Tests

- **Backend** (`tests/*.test.ts`, `node:test`). Each test starts a real server on a temporary data directory and calls it through the typed API contract. The tests cover authorization, uploads and resume, storage limits, usage, ZIP64 layout, links, requests and pickup codes.
- **Resources** (`npm run test:resources`). Real PDF rendering and native worker lifecycle, canvas bounds, and hidden Add Device polling in Chromium, Firefox and WebKit.
- **Browser** (`tests/browser/*.spec.ts`, Playwright). These run full user journeys against a production build on port 3091 (change it with `RELAY_TEST_PORT`). They include keyboard, focus and accessibility checks with axe. The Nearby journeys connect two browsers by their local addresses, which only Chromium can be told to reveal, so they run in Chromium and the mobile viewport only.

Tests never touch real data. Every instance uses a new temporary directory and generated files.

## Release verification

These scripts exercise Relay at a scale that's too slow for every commit. Each one uses disposable storage and generated content.

| Command                                                  | What it checks                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:scale`                                   | Uploads a 2 GiB file with a server restart halfway through, then checks the download's SHA-256. Uploads 10,000 files and checks every ZIP path and hash.                                                         |
| `npm run verify:browser-scale`                           | Sends 10,000 files through a real browser.                                                                                                                                                                       |
| `npm run verify:container`                               | Builds the Docker image and checks the single-writer lock, recovery after `SIGKILL` and a full disk, on throwaway containers and volumes.                                                                        |
| `npm run verify:compose`                                 | Runs the portable Compose stack with the prebuilt `relay-verify` image, checking compressed wire bytes, cache headers and the end-to-end deployment verifier. Build with `docker build -t relay-verify .` first. |
| `npm run verify:deployment -- --run-live --origin <url>` | Smoke-tests a running instance end to end. It needs `RELAY_VERIFY_USERNAME` and `RELAY_VERIFY_PASSWORD`, and never runs without `--run-live`.                                                                    |

Each script's header comment lists its options, for example `--size 80MiB --files 300` for a quick run.

## Conventions

- **One API contract.** Add or change endpoints in `shared/api.ts` first. The server routes and client calls pick up its types.
- **Database changes** go in `server/db/schema.sql`. The known v1 Activity schema upgrades transactionally to v2, preserving saved content and account data. Legacy timestamp read markers become sequence markers; events exactly at the old marker remain unread once because v1 cannot distinguish a later arrival in that millisecond. Unknown or partial schemas fail startup without changing their data; use the matching build to open them.
- **Formatting and linting.** Prettier formats with a 120-character line width, and ESLint checks types, promises and React Hooks. Run `npm run check` before you open a pull request. It runs everything CI runs except the browser tests.
- **Lint exceptions** are rare, and each one says why on the same line: `// eslint-disable-next-line <rule> -- <reason>`.
- **Authorization** is required on every content and archive route, and every new route needs a test that proves outsiders are refused.
- **User-facing claims stay honest.** Never show something as saved, sent or delivered before the server has confirmed it.
