# Contributing

Thanks for helping make classroom review more inclusive and useful.

## Before you start

- Search existing issues and open one before a large behavior or architecture change.
- Never include student data, real session codes, credentials, private URLs, recordings, or unlicensed classroom materials.
- Keep the default experience usable by a teacher running one Docker Compose command.
- Treat accessibility, privacy, and age-appropriate language as product requirements.

## Local checks

Use Node.js 24 or newer:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
docker build -t 1v100-classroom:dev .
```

Add or update tests for behavior changes. Keep commits focused and explain user-visible changes in the pull request.

## Questions and assets

Only contribute questions, images, fonts, audio, or video that you created or have clear permission to redistribute. State the source and license in the pull request. Do not contribute student work or classroom recordings without documented authority and explicit review.

By submitting a contribution, you agree that it is licensed under the Apache License 2.0 unless the file clearly carries a compatible third-party license and attribution.
