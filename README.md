# Course MDC · Project Showcase & Evaluation Dashboard

A responsive dashboard for managing submissions, live device previews and tiered evaluations for the 64-student Course MDC cohort.

Static vanilla JS/CSS frontend (`public/`) plus a single Node API function (`api/index.js` → `lib/app.js`), backed by MongoDB. Built to deploy on Vercel.

## Project layout

```
api/index.js     Vercel serverless entry; all /api/* requests are rewritten here
lib/app.js       API routes, validation, auth, embed check
lib/export.js    Faculty exports: PDF / HTML report, Excel, CSV, JSON
lib/xlsx.js      Dependency-free .xlsx reader (roster) and writer (export)
lib/frame.js     Whether a site's X-Frame-Options / CSP frame-ancestors lets the preview embed it
lib/store.js     Storage: MongoDB when MONGODB_URI is set, else data/projects.json
public/          Frontend (served as static files)
server.js        Local dev server (static files + the same API handler)
scripts/seed.js  Seed, reset or import data
tests/smoke.js   End-to-end API tests (npm test)
tests/*.test.js  Unit tests (npm run test:unit)
vercel.json      Output dir, bom1 region, /api rewrite, security headers
```

## Environment variables

| Variable           | Required          | Default           | Purpose |
| ------------------ | ----------------- | ----------------- | ------- |
| `MONGODB_URI`      | On Vercel         | none              | Atlas connection string |
| `MONGODB_DB`       | No                | `course_mdc`      | Database name |
| `TEACHER_PASSWORD` | Optional          | `***************` | Initial faculty password, used until one is set in Control Center → Security |

The default password is published in the project spec, so set your own before the site goes public.

## Deploy to Vercel + MongoDB Atlas

1. **Database user.** In Atlas, open *Project 0 → Database Access* and add a user with the **readWrite** role on the `course_mdc` database only. Don't reuse the admin account.
2. **Network access.** Vercel functions don't have fixed IP addresses, so in *Network Access* allow `0.0.0.0/0`. The database user's password still protects the cluster.
   *Shortcut for steps 1–2:* install the official [MongoDB Atlas integration](https://vercel.com/marketplace/mongodbatlas) from the Vercel dashboard. It creates the user, opens network access and sets `MONGODB_URI` for you.
3. **Vercel project.** Import this folder (push it to GitHub and import it, or run `npx vercel` here). `vercel.json` already sets the framework to *Other*, the output directory to `public` and the region to `bom1` (Mumbai, the same region as the Atlas cluster).
4. **Environment variables.** In *Project → Settings → Environment Variables*, add `MONGODB_URI` and `TEACHER_PASSWORD` (mark both *Sensitive*), then redeploy.
5. **Check.** Open `https://<your-app>.vercel.app/api/health`. It should return `{"ok":true,"storage":"mongodb"}`.

MongoDB indexes are created automatically on the first request. Unique indexes stop two teams from having the same name and stop a student from joining two teams, even when two submissions arrive at the same moment.

## Local development

```bash
npm install
npm start
```

Open http://localhost:3000. Without a `.env.local` file, data is stored in `data/projects.json`. To develop against Atlas instead, copy `.env.example` to `.env.local` and fill it in. Atlas must allow your IP address.

| Command          | Effect |
| ---------------- | ------ |
| `npm run seed`   | Replace all data with 12 demo teams |
| `npm run reset`  | Delete all projects |
| `npm run import` | Copy `data/projects.json` into MongoDB (needs `MONGODB_URI`) |
| `npm run reset-password` | Remove the password set in Control Center, so sign-in falls back to `TEACHER_PASSWORD` or the default |

These commands target MongoDB when `MONGODB_URI` is set and the JSON file otherwise. When using the JSON file, stop the server before running them.

## Submission types

**Submit project** opens a menu with two options. Both take a team name, project title, team members, tech stack and notes, and a GitHub link.

| Type | Showcase link | Stored as |
| --- | --- | --- |
| Web project | Live deployment URL, e.g. Vercel | `type: "web"`, `vercelUrl` |
| Desktop / mobile app | Google Drive folder with the demo video, slides and other files (`drive.google.com` links only) | `type: "app"`, `demoUrl` |

Faculty can browse a desktop / mobile app's Drive folder inside the preview window while grading. This works for folder links (`drive.google.com/drive/folders/…`) and single-file links shared as "Anyone with the link"; other Drive links open in Google Drive instead. Projects submitted before types existed count as web projects. Every export records each project's type and its Drive folder link.

Web projects open in the preview at desktop, tablet or phone width. Browsers won't show a site there if it sends `X-Frame-Options: DENY` / `SAMEORIGIN`, or a CSP `frame-ancestors` rule that doesn't list the dashboard. The preview then offers to open the site in a pop-up window of the chosen device size, and shows the header the team can send to allow the dashboard while keeping clickjacking protection: `Content-Security-Policy: frame-ancestors 'self' https://<your-dashboard>`.

## Exports (faculty)

The **Export** button (hero and footer) opens a dialog with five formats. Exports always include scores, tiers, ranks and reviewer notes, even while results are hidden from students, so only signed-in faculty can export; anyone else is asked to sign in first. The Danger zone's **Export** button opens the same dialog with JSON selected, for a backup before bulk actions.

| Format | File | What you get |
| --- | --- | --- |
| PDF report | `<course>-report-<date>.pdf` | The report described below, opened in the browser's print dialog. Choose **Save as PDF** as the destination. A4 landscape, with the theme's background on every page and the table header repeated across pages |
| Web report | `<course>-report-<date>.html` | The same report as one self-contained page to share or archive. It needs no server, loads the Geist fonts from Google Fonts and adapts to phone screens |
| Excel workbook | `<course>-grades-<date>.xlsx` | Three sheets. **Overview**: course details, the four stats and the tier distribution. **Submissions**: one row per team with a frozen, filterable header, clickable links, numeric scores and real dates. **Leaderboard**: graded teams by rank |
| CSV | `<course>-grades-<date>.csv` | One row per team with the original columns (type, links, score, tier, status, notes, timestamps), for Google Sheets or any tool |
| JSON backup | `<course>-backup-<date>.json` | The complete data: course details, summary stats, export scope and every project with its rank, tier and grading state |

`<course>` is the course name from Control Center → Course, and `<date>` is the export day in your time zone. Filtered exports add `-filtered` to the name.

**The report** (PDF and web) mirrors the dashboard: the course wordmark and program pill, an inverted cohort card, the stats strip (teams, graded, pending, class average), a tier distribution bar with counts, a top-three podium with score rings, and every team with member avatars, project type, live site / Drive and GitHub links, score, tier badge, rank and reviewer notes.

**Dialog options**

- **Theme**: Light or Dark, defaulting to the theme you're using. It applies to the PDF, web report and workbook; CSV and JSON have no styling.
- **Teams**: *All teams*, or *Current view* to export only the teams matching the dashboard's tier filter and search. *Current view* is available when a filter or search is active, and the dialog shows how many teams each choice includes.

The dialog remembers your last format and theme in this browser. Dates are written in your local time zone. The workbook asks Excel for the Geist font and falls back to a standard sans-serif on computers without it; colours and layout stay the same. Ranks match the leaderboard: tied scores share a rank.

## Control Center (faculty)

After signing in, faculty get a **Control** button in the top bar. Every setting is enforced by the API, not just hidden in the page.

| Section | What it controls |
| --- | --- |
| Overview | Live status with one-click toggles to open/close submissions and publish/hide results |
| Submissions | Accept submissions on/off, an automatic deadline, course capacity, maximum team size |
| Results | Publish or hide scores. While hidden, students see every project as Pending, a locked leaderboard and no class average; faculty views are unchanged |
| Course | Course name (top bar, footer, page title), the homepage heading details (program, semester, batch) and an announcement banner shown to everyone |
| Activity | Log of sign-ins, submissions, grades, edits, deletions and setting changes, kept for 180 days |
| Roster | Upload the class list (.xlsx, .csv, or rows pasted from Excel; Roll Number / Email / Student Name columns are detected automatically) and see who has **not submitted**. Names are matched forgivingly: titles (Mr./Ms.), case, punctuation and one-letter typos are ignored, and partial names such as first + last name are flagged as **possible matches** for faculty to confirm. Copy the missing students or export everyone's status as CSV. Faculty-only; stored in the `roster` collection |
| Security | Change the faculty password (current password required; at least 10 characters with letters and a number or symbol). Changing it signs out every other faculty session. Warns while the published default is still active |
| Danger zone | Export backup, sign out all faculty, clear all scores (type `RESET`), delete all projects (type `DELETE`) |

Faculty can still add or edit teams while submissions are closed, and their edits aren't limited by team size or capacity. Settings live in the `settings` collection and the log in `activity`.

## Testing

```bash
npm test                                          # against http://localhost:3000
BASE_URL=https://your-app.vercel.app npm test     # against a deployment
```

This runs the end-to-end API checks covering the core API, both submission types, every export format and the Control Center. The faculty password comes from `TEACHER_PASSWORD` (environment variable or `.env.local`); after changing it in the Control Center, set `TEACHER_PASSWORD` to the new password when running the tests. Password changes only have their guards tested, so the suite never changes the real password, and the roster upload flow only runs against localhost.

Test teams are deleted and settings restored afterwards. Destructive bulk actions only have their confirmation guards tested, and "sign out all faculty" only runs against localhost. The suite signs in several times, so wait a minute before signing in from the browser if you hit the sign-in rate limit.

Unit tests cover roster parsing, name matching, the .xlsx reader and writer, every export format (columns, filtering, ranks, time zones, HTML escaping) and the preview's embedding check (frame-ancestors sources, ports, wildcards, X-Frame-Options precedence). They use made-up names and need no server:

```bash
npm run test:unit
```

## How it works on serverless

- **Faculty sessions** are random tokens sent in the `x-teacher-token` header and kept only in page memory. The server stores a SHA-256 hash of each token in the `sessions` collection, which expires entries after 12 hours, so any function instance can check a token and signing out revokes it.
- **Faculty password** set in the Control Center is stored as a salted scrypt hash in the `credentials` collection and never returned by the API. Forgot it? Run `npm run reset-password` with `MONGODB_URI` in `.env.local`, then sign in with `TEACHER_PASSWORD` or the default and set a new one.
- **Sign-in rate limiting** allows 8 attempts per minute per IP address (password-change attempts count too), tracked in the `login_attempts` collection, which also expires old entries.
- **Student submissions** need no login and always start as *Pending*.
- **Reviewer notes** are feedback for the team. They appear on the dashboard (a feedback icon beside the score in the table, an excerpt on Showcase cards and the preview panel) once the project is graded and results are published; until then only faculty can see them.

## API

| Method   | Path                    | Auth    |
| -------- | ----------------------- | ------- |
| `GET`    | `/api/health`           | public  |
| `GET`    | `/api/projects`         | public (reviewer notes included once a project is graded and results are published) |
| `POST`   | `/api/projects`         | public  |
| `PATCH`  | `/api/projects/:id`     | faculty |
| `DELETE` | `/api/projects/:id`     | faculty |
| `GET`    | `/api/export/:format`   | faculty; see below |
| `POST`   | `/api/auth/login`       | body `{ "password": "…" }` |
| `POST`   | `/api/auth/logout`      | faculty |
| `GET`    | `/api/auth/session`     | public (returns `{ authenticated }` for the sent token) |
| `GET`    | `/api/frame-check?url=&from=` | public (`from` is the dashboard's origin; defaults to the request's host) |
| `PATCH`  | `/api/admin/settings`   | faculty |
| `GET`    | `/api/admin/activity?limit=` | faculty |
| `POST`   | `/api/admin/reset-scores` | faculty, body `{ "confirm": "RESET" }` |
| `POST`   | `/api/admin/delete-all` | faculty, body `{ "confirm": "DELETE" }` |
| `POST`   | `/api/admin/revoke-sessions` | faculty |
| `GET`    | `/api/admin/security`   | faculty (whether a custom password is set and when it changed) |
| `POST`   | `/api/admin/password`   | faculty, body `{ currentPassword, newPassword }`; returns a new token and signs out other sessions |
| `GET`    | `/api/admin/roster` | faculty (roster + submission report) |
| `POST`   | `/api/admin/roster/preview` | faculty, body `{ fileName, base64 }` or `{ text }`; parses without saving |
| `PUT`    | `/api/admin/roster` | faculty, body `{ students: [{ name, rollNo, email }] }` |
| `DELETE` | `/api/admin/roster` | faculty |

`GET /api/projects` also returns the current `settings`, including a computed `accepting` flag.

`GET /api/export/:format` takes `csv`, `json`, `xlsx`, `html` or `print`. `print` returns the report HTML without a download header (the dashboard prints it to PDF) and names the PDF in an `X-Export-Filename` header. Optional query parameters:

| Parameter | Values | Default |
| --- | --- | --- |
| `theme` | `light` or `dark` (report and workbook only) | `light` |
| `tier` | `excellent`, `verygood`, `good`, `acceptable`, `improve` or `pending` | every tier |
| `q` | Search text matched against team, title, tech stack and member names, as on the dashboard | none |
| `tz` | Minutes east of UTC for dates and file names, e.g. `330` for India | `0` |
