import { createTeacherToken } from "../../src/auth.js";
import { openDatabase } from "../../src/db.js";
import { createAppServer } from "../../src/server.js";
import { createClassroomSession } from "../../src/sessions.js";
import { attachSocketGateway } from "../../src/socket-gateway.js";
import { mintTeacherKey } from "../../src/teachers.js";

const databasePath = process.argv[2];
const tokenSecret = process.argv[3];
if (databasePath === undefined || tokenSecret === undefined) {
  throw new Error("Expected database path and token secret");
}

const database = openDatabase(databasePath);
const teacher = mintTeacherKey(database, "Process guard teacher");
const classroom = createClassroomSession(database, teacher.teacherId, tokenSecret);
const teacherToken = createTeacherToken(teacher.teacherId, tokenSecret);
const server = createAppServer({ database, tokenSecret });
const gateway = attachSocketGateway(server, { database, tokenSecret, preAuthRateLimitPerSecond: 100 });

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }
  process.stdout.write(
    `${JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      code: classroom.code,
      teacherToken,
    })}\n`,
  );
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (command: string) => {
  if (command.trim() === "close_database" && database.open) {
    database.close();
    process.stdout.write(`${JSON.stringify({ database_closed: true })}\n`);
  }
});

process.once("SIGTERM", () => {
  void gateway.close(() => {
    server.close(() => {
      if (database.open) {
        database.close();
      }
      process.exit(0);
    });
  });
});
