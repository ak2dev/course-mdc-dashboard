# Course MDC · Project Showcase & Evaluation Dashboard

A responsive dashboard for managing submissions, live device previews and tiered evaluations for the 64-student Course MDC cohort.

Static vanilla JS/CSS frontend (`public/`) plus a single Node API function (`api/index.js` → `lib/app.js`), backed by MongoDB. Built to deploy on Vercel.

## Project layout

```
api/index.js     Vercel serverless entry; all /api/* requests are rewritten here
lib/app.js       API routes, validation, auth, CSV export, embed check
lib/store.js     Storage: MongoDB when MONGODB_URI is set, else data/projects.json
public/          Frontend (served as static files)
server.js        Local dev server (static files + the same API handler)
scripts/seed.js  Seed, reset or import data
tests/smoke.js   End-to-end API tests (npm test)
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
| Desktop / mobile app | Demo video on Google Drive (`drive.google.com` links only) | `type: "app"`, `demoUrl` |

Faculty can watch a desktop / mobile app's demo inside the preview window while grading. This only works for links to a single file (`drive.google.com/file/d/…`) shared as "Anyone with the link"; folder links open in Google Drive instead. Projects submitted before types existed count as web projects. The CSV export includes "Project Type" and "Demo Video URL" columns.

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
| Danger zone | CSV backup, sign out all faculty, clear all scores (type `RESET`), delete all projects (type `DELETE`) |

Faculty can still add or edit teams while submissions are closed, and their edits aren't limited by team size or capacity. Settings live in the `settings` collection and the log in `activity`.

## Testing

```bash
npm test                                          # against http://localhost:3000
BASE_URL=https://your-app.vercel.app npm test     # against a deployment
```

This runs 64 end-to-end API checks covering the core API, both submission types and the Control Center. The faculty password comes from `TEACHER_PASSWORD` (environment variable or `.env.local`); after changing it in the Control Center, set `TEACHER_PASSWORD` to the new password when running the tests. Password changes only have their guards tested, so the suite never changes the real password, and the roster upload flow only runs against localhost.

Unit tests for roster parsing, name matching and the .xlsx reader use made-up names and need no server:

```bash
npm run test:unit
``` Test teams are deleted and settings restored afterwards. Destructive bulk actions only have their confirmation guards tested, and "sign out all faculty" only runs against localhost.

## How it works on serverless

- **Faculty sessions** are random tokens sent in the `x-teacher-token` header and kept only in page memory. The server stores a SHA-256 hash of each token in the `sessions` collection, which expires entries after 12 hours, so any function instance can check a token and signing out revokes it.
- **Faculty password** set in the Control Center is stored as a salted scrypt hash in the `credentials` collection and never returned by the API. Forgot it? Run `npm run reset-password` with `MONGODB_URI` in `.env.local`, then sign in with `TEACHER_PASSWORD` or the default and set a new one.
- **Sign-in rate limiting** allows 8 attempts per minute per IP address (password-change attempts count too), tracked in the `login_attempts` collection, which also expires old entries.
- **Student submissions** need no login and always start as *Pending*.
- **Reviewer notes** are feedback for the team. They appear on the dashboard (a **Feedback** button in the table, an excerpt on Showcase cards and the preview panel) once the project is graded and results are published; until then only faculty can see them.

## API

| Method   | Path                    | Auth    |
| -------- | ----------------------- | ------- |
| `GET`    | `/api/health`           | public  |
| `GET`    | `/api/projects`         | public (reviewer notes included once a project is graded and results are published) |
| `POST`   | `/api/projects`         | public  |
| `PATCH`  | `/api/projects/:id`     | faculty |
| `DELETE` | `/api/projects/:id`     | faculty |
| `GET`    | `/api/export/csv`       | faculty |
| `POST`   | `/api/auth/login`       | body `{ "password": "…" }` |
| `POST`   | `/api/auth/logout`      | faculty |
| `GET`    | `/api/frame-check?url=` | public  |
| `PATCH`  | `/api/admin/settings`   | faculty |
| `GET`    | `/api/admin/activity?limit=` | faculty |
| `POST`   | `/api/admin/reset-scores` | faculty, body `{ "confirm": "RESET" }` |
| `POST`   | `/api/admin/delete-all` | faculty, body `{ "confirm": "DELETE" }` |
| `POST`   | `/api/admin/revoke-sessions` | faculty |
| `GET`    | `/api/admin/roster` | faculty (roster + submission report) |
| `POST`   | `/api/admin/roster/preview` | faculty, body `{ fileName, base64 }` or `{ text }`; parses without saving |
| `PUT`    | `/api/admin/roster` | faculty, body `{ students: [{ name, rollNo, email }] }` |
| `DELETE` | `/api/admin/roster` | faculty |

`GET /api/projects` also returns the current `settings`, including a computed `accepting` flag.
