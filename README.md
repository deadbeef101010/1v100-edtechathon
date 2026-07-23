# 1 vs 100 Classroom

**A self-hosted classroom review game where one student takes on the rest of the class—and nobody stops playing.**

[Watch the 60-second showcase](https://pub-29caf1c9c7db494a9b0bf7bb55582757.r2.dev/1v100/1v100-showcase-60s-final.mp4)

> Our one key feature is that **no kid ever gets knocked out** — in 1v100, missing a question just changes your role, so every student is still answering, still scoring, and still learning on the very last question of the game.

## Why this exists

This project started with a 7th-grade math teacher's problem:

> I wanted a review game based on the game show *1 vs 100*. One student is chosen to go against the rest of the class, answering questions about a chosen topic.
>
> Most review games are designed so there is one winner, and they also charge teachers or schools extra for access to other features. I wanted something where one student would face the rest of the class, challenging them to outlast their peers in a fun and engaging way.

## How a game works

1. A teacher signs in, imports or selects a question set, and creates a session.
2. Students join with the six-character session code and a nickname.
3. The teacher chooses **The One**; everyone else becomes **The 100**.
4. The 100 answer first. Then The One answers—or uses available help.
5. Scores and roles evolve across the game, but every student keeps participating through the final question.

The teacher controls the pace, the projector shows the shared game state, and each student answers on their own device. A session holds up to 40 students.

## Quickstart with Docker

Requirements: Docker Engine or Docker Desktop with Compose.

```bash
cp .env.example .env
```

Generate two separate credentials. Save the meta-administrator key in a password manager; only its hash goes in `.env`.

```bash
node -e "const c=require('node:crypto'); console.log(c.randomBytes(32).toString('base64url'))"
node -e "const c=require('node:crypto'); const key=c.randomBytes(32).toString('base64url'); console.log('META KEY (save this):', key); console.log('META_KEY_SHA256:', c.createHash('sha256').update(key).digest('hex'))"
```

Put the first output in `PLAYER_TOKEN_SECRET` and the second command's digest in `META_KEY_SHA256`. Keep the raw meta key out of `.env`, source control, screenshots, and chat.

Start the app:

```bash
docker compose up --build -d
curl --fail http://localhost:8000/health
```

Then:

1. Open `http://localhost:8000/meta` and use the saved meta key.
2. Mint a teacher key and save it immediately; the app stores only its digest and shows the key once. Teacher keys expire after 90 days.
3. Open `http://localhost:8000/teach`, sign in with the teacher key, and import [`examples/sample-questions.csv`](examples/sample-questions.csv).
4. Create a session, open its projector view, and send students to `http://localhost:8000/join`.

Stop cleanly with `docker compose stop`. Start again with `docker compose start`; the named SQLite volume is retained.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `HOST` | No | `127.0.0.1` | Network interface. The container sets `0.0.0.0`. |
| `PORT` | Yes outside Docker | — | HTTP and Socket.IO port. The container uses `8000`. |
| `DATABASE_PATH` | Yes | — | SQLite file path. The parent directory must exist and be writable. |
| `PLAYER_TOKEN_SECRET` | Yes | — | Exactly 32 random bytes encoded as 43-character base64url; signs player and session tokens. |
| `META_KEY_SHA256` | Yes | — | Lowercase SHA-256 digest of the separate meta-administrator key. |
| `BASE_URL` | No | — | Public absolute URL, validated at startup and reported by `/health`. |
| `LOG_LEVEL` | No | `info` | Minimum JSON log level written to stdout: `info`, `warn`, or `error`. |
| `BUILD_SHA` | No | — | Safe revision label reported by `/health`. |
| `NODE_ENV` | No | — | Runtime mode; the production image sets `production`. |
| `APP_PORT` | Compose only | `8000` | Host port mapped to the container. |
| `IMAGE` | Compose only | `ghcr.io/deadbeef101010/1v100-edtechathon:latest` | Image pulled by Compose. Pin a release tag in production; `.env.example` deliberately pins the current release. |

Legacy `DB_PATH`, `TOKEN_SECRET`, and `META_KEY_HASH` aliases remain accepted for upgrades and are covered by tests. New deployments should use the canonical names above. `DEV_VIEWS` and `DEV_TOKEN` are development-only; never expose developer views on a public deployment.

## Importing questions

Teachers can upload CSV files from the teacher console. The example file is original project material released under this repository's Apache 2.0 license.

Required columns:

| Column | Format |
| --- | --- |
| `set title` | Non-empty question-set name |
| `subject` | Non-empty subject label |
| `grade` | Non-empty grade label |
| `question` | Question prompt |
| `choices` | JSON array containing exactly three distinct, non-empty strings |
| `correct` | Zero-based index: `0`, `1`, or `2` |
| `explanation` | Optional explanation text; the column must still be present |

An optional positive `position` column controls ordering. Imports are atomic by default: any invalid row rejects the file. Review all questions for accuracy, age appropriateness, accessibility, and licensing before classroom use. The optional `gen-questions` command calls an external model API and its output must be reviewed by a teacher. It reads `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL`, and sends prompts to `https://api.openai.com/v1` by default; rejected model output is saved to a local `.rejected` file for review.

## Deploying the published image

The release workflow publishes multi-platform Linux images for AMD64 and ARM64. Pin the release tag:

```bash
docker pull ghcr.io/deadbeef101010/1v100-edtechathon:v0.1.0
```

For Compose, set `IMAGE=ghcr.io/deadbeef101010/1v100-edtechathon:v0.1.0` in `.env`, then run:

```bash
docker compose pull
docker compose up -d
```

Terminate TLS in your hosting platform or reverse proxy and set `BASE_URL` to the public HTTPS origin. The proxy must send `X-Forwarded-Proto: https`; session cookies are only marked `Secure` when that header is present. No Nginx configuration is included or required. Expose only the application port; keep the database volume private. If the reverse proxy runs on the same host, bind the published port to localhost (`ports: "127.0.0.1:${APP_PORT:-8000}:8000"` in a Compose override) so direct HTTP cannot bypass the proxy.

### Backup, restore, and upgrades

The app stores its durable state in one SQLite database at `/data/game.db` in the `game-db` volume. For a consistent file backup:

```bash
mkdir -p backups
docker compose stop app
docker compose cp app:/data/game.db ./backups/game.db
docker compose start app
```

A clean stop checkpoints the write-ahead log into `game.db`, so the single-file copy is complete. If the previous shutdown was not clean (a crash or forced kill), also copy `game.db-wal` and `game.db-shm` before restarting. Protect backups like student records. Test restore procedures on a separate deployment before relying on them. To upgrade, take a backup, change `IMAGE` to a newer pinned release, run `docker compose pull`, and then `docker compose up -d`. Database migrations run automatically at startup and are one-way; restoring the pre-upgrade backup is the rollback path.

## Architecture and data

The application is a Node.js/TypeScript server with static browser clients, Socket.IO realtime updates, and SQLite persistence. It is designed for one trusted school or teacher-operated deployment, not as a multi-tenant SaaS platform. There is no third-party analytics or required cloud service; optional AI-assisted question generation is a separate command that sends prompts to the configured model provider.

Student nicknames, session activity, answers, scores, teacher-account metadata, and authentication audit events are stored in SQLite. Structured logs redact known credential and answer fields, but operators should still restrict log access and retention. Authentication audit events are written to an append-only table that is never pruned; sign-in rate limits cap its growth per minute, not in total.

## Privacy, security, and limitations

- Use pseudonyms if your school policy does not permit student names.
- Obtain any required school or guardian approval before processing classroom data.
- Keep signing secrets, meta keys, teacher keys, logs, and database backups out of source control.
- The database is not encrypted at rest. Use encrypted storage and backups when required.
- The app does not provide SSO, automated roster sync, content moderation, or multi-tenant isolation.
- Sign-in endpoints are rate limited per source and globally. Because the global cap is shared, sustained unauthenticated traffic can temporarily lock out teacher and organizer sign-in (active sessions keep working). If the app is reachable from the internet, keep it behind school network controls or add a proxy-level rate limit or allow-list.
- A single application instance should own a database file; do not place SQLite on a shared network filesystem.
- The project is provided as-is without an uptime, support, privacy, or security SLA. See [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

This independent classroom project is inspired by a television quiz-show format and is not affiliated with or endorsed by the program's producers or rights holders.

## Development

Node.js 24 or newer is required.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Source is at [github.com/deadbeef101010/1v100-edtechathon](https://github.com/deadbeef101010/1v100-edtechathon), and published versions are on the [Releases page](https://github.com/deadbeef101010/1v100-edtechathon/releases).

## Acknowledgements

Built during [EdTech-a-thon](https://edtechathon.com), a three-day problem-solving marathon that pairs educators and developers around “Real teachers. Real problems. Real solutions.” This acknowledgement does not imply event ownership or endorsement of the project.

The offline confetti effect uses `canvas-confetti` 1.9.4 under the ISC License. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Copyright 2026 deadbeef101010 and the 1 vs 100 Classroom contributors.

Project code and original sample questions are available under the [Apache License 2.0](LICENSE). Third-party components remain under their respective licenses.
