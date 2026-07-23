import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const arguments_ = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
};
const capture = value("--capture");
if (capture !== undefined) writeFileSync(capture, JSON.stringify(arguments_));

if (arguments_.includes("--runaway")) {
  process.stdout.write("x".repeat(512 * 1_024));
} else if (arguments_.includes("--many-oversized-lines")) {
  for (let index = 0; index < 100; index += 1) process.stdout.write(`${"x".repeat(20 * 1_024)}\n`);
} else if (arguments_.includes("--many-safe-lines")) {
  for (let index = 0; index < 250; index += 1) {
    process.stdout.write(`[Bot01] answered q=test-${index} choice=2\n`);
  }
} else {
  process.stdout.write("[Bot01] joined player=12345678\n");
  process.stdout.write("[Bot01] answered q=test-question choice=2\n");
  process.stdout.write("[Bot01] reveal q=test-question correct=yes\n");
  process.stdout.write("[Bot01] resumed phase=QUESTION_OPEN\n");
  process.stdout.write("[Bot02] error=test failure\n");
}

if (value("--count") === "1") {
  setTimeout(() => process.exit(0), 40);
} else {
  const keepAlive = setInterval(() => undefined, 1_000);
  if (arguments_.includes("--spawn-descendant")) {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const descendantCapture = value("--descendant-capture");
    if (descendantCapture !== undefined && descendant.pid !== undefined) {
      const processGroup = process.platform === "linux"
        ? spawnSync("ps", ["-o", "pgid=", "-p", String(descendant.pid)], { encoding: "utf8" }).stdout.trim()
        : "unsupported";
      writeFileSync(descendantCapture, `${descendant.pid}:${processGroup}:${process.pid}`);
    }
  }
  process.once("SIGTERM", () => {
    if (arguments_.includes("--ignore-term")) return;
    clearInterval(keepAlive);
    process.exit(0);
  });
}
