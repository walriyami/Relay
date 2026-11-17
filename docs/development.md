# Development

For product and engineering reviews, follow [Reviewing Relay](review.md). Existing behavior and passing tests are
evidence to assess; they do not establish the best behavior for users. Historical AI reports and working bundles
are archived outside the active review context.

## Setup

```sh
npm ci
npm run dev
```

Open http://localhost:5178. The first time, Relay walks you through setup and creates your administrator account. `npm run dev` runs the API on port 3090 with automatic restarts, Vite with hot reload on port 5178, which proxies API calls, and the direct-transfer helper on UDP port 3090, so this machine's browsers get direct transfers. Local data goes to `.data/`. Delete that folder to start over.

Relay needs Node.js 24, which can run TypeScript directly, so there's no compile step. The project pins Node 24 as a dev dependency, and every npm script runs on it even when your system has an older Node. To run a file directly, use `npx node <file>`.

## Commands

| Command                           | What it does                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                     | API and Vite dev server with reload                                                   |
| `npm run build`                   | Type-checks everything and builds the web app into `dist/`                            |
| `npm run check`                   | Formatting, type-check, lint and backend tests: the same checks as CI                 |
| `npm run typecheck`               | TypeScript, without building                                                          |
| `npm run lint` / `lint:fix`       | ESLint                                                                                |
| `npm start`                       | Runs the production server, which serves `dist/`                                      |
| `npm test`                        | Backend integration tests on disposable instances                                     |
| `npm run test:e2e`                | Builds, then runs the browser journeys in Chromium                                    |
| `npm run test:e2e:all`            | Builds, then runs them in Chromium, Firefox, WebKit and a mobile viewport, as CI does |
| `npm run format` / `format:check` | Prettier                                                                              |
| `npm run screenshots`             | Regenerates `docs/images` from generated demo content. Run `npm run build` first.     |

Install the browsers once before the first end-to-end run:

```sh
npx playwright install --with-deps
```

## Tests

- **Backend** (`tests/*.test.ts`, `node:test`). Each test starts a real server on a temporary data directory and calls it through the typed API contract. The tests cover authorization, uploads and resume, storage limits, usage, ZIP64 layout, links, requests and pickup codes.
- **Resources** (`npm run test:resources`, or `test:resources:all` for Firefox and WebKit too). Real PDF rendering and native worker lifecycle, canvas bounds, and hidden Add Device polling.
- **Browser** (`tests/browser/*.spec.ts`, Playwright). These run full user journeys against a production build on port 3091 (change it with `RELAY_TEST_PORT`). They include keyboard, focus and accessibility checks with axe. The Nearby journeys connect two browsers by their local addresses, which only Chromium can be told to reveal, so they run in Chromium and the mobile viewport only.

Tests never touch real data. Every instance uses a new temporary directory and generated files.

Test instances hash passwords at a much lower cost than production (`useTestPasswordCost` in `server/lib/secrets.ts`), because tests sign in hundreds of times.

### Choosing what to run

Run the tests for what you changed, not every suite each time. The browser suites cost far more than the rest.

- While working, run single files: `npx node --test tests/links.test.ts`, or `npx playwright test tests/browser/send.spec.ts --project=chromium` after `npm run build`. Add `-g "<name>"` for one test, and `--trace on` to record a failing one.
- Before committing, `npm run check`, plus `npm run test:e2e` when the change shows in the browser.
- Leave `test:e2e:all` and `test:resources:all` to CI, or run them when a change depends on how Firefox or Safari behave.

## Release verification

These scripts exercise Relay at a scale that's too slow for every commit. Each one uses disposable storage and generated content.

| Command                                                  | What it checks                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:scale`                                   | Uploads a 2 GiB file with a server restart halfway through, then checks the download's SHA-256. Uploads 10,000 files and checks every ZIP path and hash. |
| `npm run verify:browser-scale`                           | Sends 10,000 files through a real browser.                                                                                                               |
| `npm run verify:container`                               | Builds the Docker image and checks the single-writer lock, recovery after `SIGKILL` and a full disk, on throwaway containers and volumes.                |
| `npm run verify:deployment -- --run-live --origin <url>` | Smoke-tests a running instance end to end. It needs `RELAY_VERIFY_USERNAME` and `RELAY_VERIFY_PASSWORD`, and never runs without `--run-live`.            |

Each script's header comment lists its options, for example `--size 80MiB --files 300` for a quick run.

## Releasing

Commit the change, then deploy that commit as described in [Hosting](hosting.md#updating):
`walctl deploy relay-production --commit main`. A build from uncommitted files stops with an error, because the
image must record the commit it holds; `/api/health` and **Admin → Service health** then show it. To build an
image locally, name the commit: `docker build --build-arg RELAY_COMMIT=$(git rev-parse HEAD) .`

`npm run bench:transfers` measures Direct transfers, Nearby and plain HTTP the way they run on real devices: each browser and the server in a container of its own, sending over links shaped like fast, typical and weak Wi-Fi (`--profiles wifi6,wifi7` go past what a 400 Mbit/s connection carries), with phones given one or two CPUs. Numbers from one computer talking to itself only show the best case, so judge changes to either path with this. It needs Docker; `--source <checkout>` measures another checkout, such as `main`, to compare with, and results also go to `bench-results.jsonl`. A transfer that doesn't finish leaves each page's text, console and a screenshot in `bench-failures/`.

## Conventions

- **One API contract.** Add or change endpoints in `shared/api.ts` first. The server routes and client calls pick up its types.
- **Database changes** go in `server/db/schema.sql`. Incompatible prerelease schemas fail startup. Preserve any wanted data and use a new empty data directory after a schema change.
- **Formatting and linting.** Prettier formats with a 120-character line width, and ESLint checks types, promises and React Hooks. Run `npm run check` before you open a pull request. It runs everything CI runs except the browser tests.
- **Lint exceptions** are rare, and each one says why on the same line: `// eslint-disable-next-line <rule> -- <reason>`.
- **Authorization** is required on every content and archive route, and every new route needs a test that proves outsiders are refused.
- **User-facing claims stay honest.** Never show something as saved, sent or delivered before the server has confirmed it.
- **Explain changes.** Commit messages and pull requests should explain the problem, resulting behavior, and reason for the choice. Include reproduction details or verification where they help. Keep lasting operating guidance in the relevant docs.
