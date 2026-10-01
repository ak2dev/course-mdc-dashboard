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
vercel.json      Output dir, bom1 region, /api rewrite, security headers
```

## Environment variables

| Variable           | Required          | Default           | Purpose |
| ------------------ | ----------------- | ----------------- | ------- |
| `MONGODB_URI`      | On Vercel         | none              | Atlas connection string |
| `MONGODB_DB`       | No                | `course_mdc`      | Database name |
| `TEACHER_PASSWORD` | Strongly advised  | `mdc@teacher2026` | Instructor key for faculty mode |

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

These commands target MongoDB when `MONGODB_URI` is set and the JSON file otherwise. When using the JSON file, stop the server before running them.

## How it works on serverless

- **Faculty sessions** are random tokens sent in the `x-teacher-token` header and kept only in page memory. The server stores a SHA-256 hash of each token in the `sessions` collection, which expires entries after 12 hours, so any function instance can check a token and signing out revokes it.
- **Sign-in rate limiting** allows 8 attempts per minute per IP address, tracked in the `login_attempts` collection, which also expires old entries.
- **Student submissions** need no login and always start as *Pending*.

## API

| Method   | Path                    | Auth    |
| -------- | ----------------------- | ------- |
| `GET`    | `/api/health`           | public  |
| `GET`    | `/api/projects`         | public (reviewer notes only sent to faculty) |
| `POST`   | `/api/projects`         | public  |
| `PATCH`  | `/api/projects/:id`     | faculty |
| `DELETE` | `/api/projects/:id`     | faculty |
| `GET`    | `/api/export/csv`       | faculty |
| `POST`   | `/api/auth/login`       | body `{ "password": "…" }` |
| `POST`   | `/api/auth/logout`      | faculty |
| `GET`    | `/api/frame-check?url=` | public  |
