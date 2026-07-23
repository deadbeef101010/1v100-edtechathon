# 1 vs 100 Classroom v0.1.0

The first public release packages the complete classroom game for self-hosting.

Highlights:

- Every student keeps playing through the final question—even after a miss changes their role.
- Separate teacher, projector, and student views support a full-class game.
- Teachers can import three-choice question sets from CSV and control the round flow.
- SQLite persistence, graceful shutdown, Docker health checks, and AMD64/ARM64 images make deployment straightforward.
- Credentials are generated per deployment; no production keys or classroom data are included.

Start with the Docker quickstart in the README. This release is intended for a single trusted school or teacher-operated deployment; review the privacy, security, and limitations section before classroom use.
