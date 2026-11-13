import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('accepts a new argument on every handler without editing its facade or context', () => {
  const facadePath = resolve('src/daemon-service.ts');
  const source = readFileSync(facadePath, 'utf8');
  const facade = ts.createSourceFile(facadePath, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of facade.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      imports.set(binding.name.text, resolve(dirname(facadePath),
        statement.moduleSpecifier.text.replace(/\.js$/, '.ts')));
    }
  }
  const service = facade.statements.find(ts.isClassDeclaration)!;
  const edits = new Map<string, { source: string; positions: Set<number> }>();
  const calls: string[] = [];
  for (const method of service.members) {
    if (!ts.isMethodDeclaration(method)) continue;
    const result = method.body?.statements[0];
    if (!result || !ts.isReturnStatement(result) || !result.expression ||
        !ts.isCallExpression(result.expression)) continue;
    const handlerName = result.expression.expression.getText(facade);
    const handlerPath = imports.get(handlerName);
    if (!handlerPath) continue; // Named construction is not a command facade.
    let edit = edits.get(handlerPath);
    if (!edit) {
      edit = { source: readFileSync(handlerPath, 'utf8'), positions: new Set() };
      edits.set(handlerPath, edit);
    }
    const ast = ts.createSourceFile(handlerPath, edit.source, ts.ScriptTarget.Latest, true);
    const handler = ast.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === handlerName)!;
    edit.positions.add(handler.parameters[handler.parameters.length - 1]!.end);
    const args = handler.parameters.slice(1).map(() => 'undefined!');
    args.push('{ addedAtHandler: true }');
    calls.push(`wiringProof.${method.name.getText(facade)}(${args.join(', ')});`);
  }
  expect(calls.length).toBeGreaterThan(100);
  const virtual = new Map<string, string>();
  for (const [path, edit] of edits) {
    let changed = edit.source;
    for (const position of [...edit.positions].sort((a, b) => b - a)) {
      changed = changed.slice(0, position) +
        ', commandDependencyProof?: { addedAtHandler: true }' + changed.slice(position);
    }
    virtual.set(path, changed);
  }
  // Compile real public calls against virtual declaration edits. A handwritten
  // mirror on any facade method makes its added-argument call fail tsc.
  virtual.set(facadePath, source + `\ndeclare const wiringProof: DaemonService;\n${calls.join('\n')}\n`);
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  host.readFile = (path) => virtual.get(path) ?? read(path);
  const program = ts.createProgram([facadePath], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}, 120_000);
