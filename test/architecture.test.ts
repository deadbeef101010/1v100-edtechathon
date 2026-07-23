import { readFile, readdir } from "node:fs/promises";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const coordinatorCommands = [
  "startSession",
  "selectNextOne",
  "updateSettings",
  "nextGame",
  "startPhaseA",
  "answerPhaseA",
  "lockPhaseA",
  "startPhaseB",
  "resumeOne",
  "pauseOneDisconnected",
  "teacherPause",
  "teacherResume",
  "helpPoll",
  "helpAsk",
  "helpTrust",
  "forceReveal",
  "answerOne",
  "reveal",
  "endGame",
  "endSession",
] as const;

const repositoryWrites = [
  "startGame",
  "updateGameSnapshot",
  "updateGameProgress",
  "applyReveal",
  "applyHelp",
  "endGame",
  "endSession",
  "updateSettings",
] as const;

async function sourceFile(path: string): Promise<ts.SourceFile> {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function classDeclaration(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  expect(declaration, `${name} declaration`).toBeDefined();
  return declaration!;
}

function classMethod(
  declaration: ts.ClassDeclaration,
  name: string,
): ts.MethodDeclaration {
  const method = declaration.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name,
  );
  expect(method, `${declaration.name?.text}.${name}`).toBeDefined();
  return method!;
}

function callsIn(node: ts.Node, source: ts.SourceFile): string[] {
  const calls: string[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate)) calls.push(candidate.expression.getText(source));
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls;
}

function newExpressionsIn(node: ts.Node): ts.NewExpression[] {
  const expressions: ts.NewExpression[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isNewExpression(candidate)) expressions.push(candidate);
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return expressions;
}

function methodName(method: ts.MethodDeclaration): string {
  return method.name.getText(method.getSourceFile());
}

function propertyName(property: ts.PropertyAssignment): string {
  return property.name.getText(property.getSourceFile()).replaceAll(/["']/g, "");
}

function containingMethod(node: ts.Node): ts.MethodDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isMethodDeclaration(current)) current = current.parent;
  return current as ts.MethodDeclaration | undefined;
}

function containingProperty(node: ts.Node, name: string): ts.PropertyAssignment | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isMethodDeclaration(current)) {
    if (ts.isPropertyAssignment(current) && propertyName(current) === name) return current;
    current = current.parent;
  }
  return undefined;
}

// Exact allowlist: factories returning a persist callback that the gateway couples
// into a coordinator proposal. A new name here requires reviewing its call sites.
const DEFERRED_PERSIST_FACTORIES = new Set(["prepareKickPause"]);

function repositoryWriteViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(source);
      const write = node.expression.name.text;
      if (receiver === "this.#repository" && repositoryWrites.some((candidate) => candidate === write)) {
        const method = containingMethod(node);
        const propose = containingProperty(node, "propose");
        const executeCall = propose?.parent.parent;
        const coordinatorBacked = executeCall !== undefined && ts.isCallExpression(executeCall) &&
          executeCall.expression.getText(source) === "this.#coordinator.execute";
        const deferredPersist = containingProperty(node, "persist") !== undefined &&
          method !== undefined && DEFERRED_PERSIST_FACTORIES.has(methodName(method));
        if (method === undefined || (!coordinatorBacked && !deferredPersist)) {
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${method === undefined ? "unknown" : methodName(method)}:${location.line + 1}:${write}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

const sqlWritePattern = /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH)\b/i;

function directSqlWriteViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["prepare", "exec"].includes(node.expression.name.text)
    ) {
      const sql = node.arguments[0];
      const text = sql !== undefined && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))
        ? sql.text.trim()
        : undefined;
      if (text !== undefined && sqlWritePattern.test(text)) {
        const method = containingMethod(node);
        const persist = containingProperty(node, "persist");
        const propose = persist === undefined ? undefined : containingProperty(persist, "propose");
        const executeCall = propose?.parent.parent;
        const coordinatorBacked = executeCall !== undefined && ts.isCallExpression(executeCall) &&
          /(?:^|\.)coordinator\.execute$/.test(executeCall.expression.getText(source));
        if (persist === undefined || propose === undefined || !coordinatorBacked) {
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${method === undefined ? "function" : methodName(method)}:${location.line + 1}:${text.split(/\s/, 1)[0]}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function repositorySqlWriteMethods(source: ts.SourceFile, declaration: ts.ClassDeclaration): Set<string> {
  const methods = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["prepare", "exec"].includes(node.expression.name.text)
    ) {
      const sql = node.arguments[0];
      const text = sql !== undefined && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))
        ? sql.text.trim()
        : undefined;
      const method = containingMethod(node);
      if (text !== undefined && sqlWritePattern.test(text) && method !== undefined) methods.add(methodName(method));
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return methods;
}

describe("socket command architecture", () => {
  it("keeps direct round mutation out of Socket.IO registration callbacks", async () => {
    const source = await readFile(new URL("../src/socket-gateway.ts", import.meta.url), "utf8");
    const registration = source.slice(source.indexOf('io.on("connection"'));

    expect(registration).not.toMatch(/round\.(?:openQuestion|answer|pause|resume|forceReveal|advance|lockExpired)\(/);
    expect(source).toContain("new CommandCoordinator(database, store, logger)");
    expect(source).toContain("new QuestionRound");
  });
});

describe("ruleset engine architecture", () => {
  it("keeps persistence and transport behind the coordinator and emitter boundaries", async () => {
    const engineDirectory = new URL("../src/engine/", import.meta.url);
    const names = (await readdir(engineDirectory)).filter((name) => name.endsWith(".ts"));
    const sources = await Promise.all(names.map(async (name) => ({
      name,
      source: await readFile(new URL(name, engineDirectory), "utf8"),
    })));

    for (const { name, source } of sources) {
      expect(source, name).not.toMatch(/\.prepare\(|\.exec\(|\.emit\(/);
      expect(source, name).not.toContain("socket.io");
      expect(source, name).not.toContain("better-sqlite3");
    }
  });

  it("routes every ruleset mutation entry point through CommandCoordinator", async () => {
    const source = await sourceFile("../src/engine/one-v-100-engine.ts");
    const engine = classDeclaration(source, "OneV100Engine");

    for (const command of coordinatorCommands) {
      const calls = callsIn(classMethod(engine, command), source);
      expect(calls, command).toSatisfy((entries: string[]) =>
        entries.includes("this.#coordinator.execute") || entries.includes("this.#answerOne"));
    }

    const deadlineCalls = callsIn(classMethod(engine, "lockExpiredPhaseA"), source);
    expect(deadlineCalls).toContain("this.lockPhaseA");
    const recoveryCalls = callsIn(classMethod(engine, "recover"), source);
    // Teacher-gated exposure: recovery holds PHASE_A_LOCKED (no startPhaseB).
    expect(recoveryCalls).toEqual(expect.arrayContaining([
      "this.reveal",
      "this.pauseOneDisconnected",
      "this.endSession",
    ]));
    expect(recoveryCalls).not.toContain("this.startPhaseB");
  });

  it("allows repository writes only in coordinator proposal paths", async () => {
    const [engineSource, repositorySource] = await Promise.all([
      sourceFile("../src/engine/one-v-100-engine.ts"),
      sourceFile("../src/ruleset-store.ts"),
    ]);
    const engine = classDeclaration(engineSource, "OneV100Engine");
    const repository = classDeclaration(repositorySource, "SqliteRulesetRepository");
    const implementedTypes = repository.heritageClauses
      ?.filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
      .flatMap((clause) => clause.types.map((type) => type.expression.getText(repositorySource))) ?? [];

    expect(implementedTypes).toContain("RulesetRepository");

    expect(repositoryWriteViolations(engineSource)).toEqual([]);
    const gatewaySource = await sourceFile("../src/socket-gateway.ts");
    for (const factory of DEFERRED_PERSIST_FACTORIES) {
      const calls = gatewaySource.text.match(new RegExp(factory + "\\(", "g")) ?? [];
      expect(calls.length, factory + " must have exactly one gateway call site (review new ones)").toBe(1);
    }
    expect(repositorySqlWriteMethods(repositorySource, repository)).toEqual(new Set(repositoryWrites));

    const allCalls = callsIn(engine, engineSource);
    for (const write of repositoryWrites) {
      expect(allCalls, write).toContain(`this.#repository.${write}`);
    }

    for (const write of repositoryWrites) {
      const calls = callsIn(classMethod(repository, write), repositorySource);
      expect(calls, `SqliteRulesetRepository.${write}`).toContain("this.#database.prepare");
    }
  });

  it("rejects a repository write added outside a coordinator path", async () => {
    const source = await readFile(new URL("../src/engine/one-v-100-engine.ts", import.meta.url), "utf8");
    const canary = source.replace(
      "  get phase(): RulesetPhase {",
      "  architectureCanary(): void { this.#repository.endSession(this.#sessionId, 0); }\n\n  get phase(): RulesetPhase {",
    );
    const parsed = ts.createSourceFile("canary.ts", canary, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    expect(repositoryWriteViolations(parsed)).toEqual([
      expect.stringMatching(/^architectureCanary:\d+:endSession$/),
    ]);
  });

  it("wires gateway ruleset commands to the shared coordinator and repository", async () => {
    const source = await sourceFile("../src/socket-gateway.ts");
    const gatewayRulesetCommands = new Set([
      "lockExpiredPhaseA",
      "resumeOne",
      "nextGame",
      "startPhaseA",
      "startPhaseB",
      "answerOne",
      "answerPhaseA",
      "endSession",
      "startSession",
      "selectNextOne",
      "updateSettings",
      "pauseOneDisconnected",
      "teacherPause",
      "teacherResume",
      "helpPoll",
      "helpAsk",
      "helpTrust",
      "forceReveal",
      "recover",
    ]);

    const constructions = newExpressionsIn(source);
    const coordinatorConstruction = constructions.find((expression) =>
      expression.expression.getText(source) === "CommandCoordinator" &&
      expression.arguments?.map((argument) => argument.getText(source)).join(",") === "database,store,logger"
    );
    expect(coordinatorConstruction, "shared gateway coordinator").toBeDefined();

    const engineConstruction = constructions.find((expression) =>
      expression.expression.getText(source) === "OneV100Engine"
    );
    expect(engineConstruction, "gateway ruleset engine").toBeDefined();
    const options = engineConstruction?.arguments?.[0];
    const optionProperties = options !== undefined && ts.isObjectLiteralExpression(options) ? options.properties : [];
    expect(optionProperties.length, "OneV100Engine options").toBeGreaterThan(0);
    expect(optionProperties.some((property) =>
      ts.isShorthandPropertyAssignment(property) && property.name.text === "coordinator"
    ), "OneV100Engine receives the shared coordinator").toBe(true);
    expect(optionProperties.some((property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText(source) === "repository" &&
      ts.isNewExpression(property.initializer) &&
      property.initializer.expression.getText(source) === "SqliteRulesetRepository" &&
      property.initializer.arguments?.[0]?.getText(source) === "database"
    ), "OneV100Engine receives the SQLite ruleset repository").toBe(true);

    const routedGatewayCommands = new Set<string>();
    for (const call of callsIn(source, source)) {
      const match = /^(?:ruleset|engine)\.([A-Za-z0-9]+)$/.exec(call);
      if (match?.[1] !== undefined && !["liveSnapshot", "isEligible", "needsRecovery"].includes(match[1])) {
        routedGatewayCommands.add(match[1]);
      }
    }
    expect(routedGatewayCommands).toEqual(gatewayRulesetCommands);
  });

  it("allows gateway SQL writes only in coordinator persist callbacks", async () => {
    const source = await sourceFile("../src/socket-gateway.ts");
    expect(directSqlWriteViolations(source)).toEqual([]);

    const text = await readFile(new URL("../src/socket-gateway.ts", import.meta.url), "utf8");
    const canary = `${text}\nfunction architectureSqlCanary(): void { database.prepare("UPDATE sessions SET status = 'ended'").run(); }`;
    const parsed = ts.createSourceFile("gateway-canary.ts", canary, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(directSqlWriteViolations(parsed)).toEqual([
      expect.stringMatching(/^function:\d+:UPDATE$/),
    ]);
  });
});
