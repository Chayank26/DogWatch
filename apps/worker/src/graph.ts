/**
 * Bounded, in-memory syntactic analysis. Parsing source never imports/executes it,
 * loads repository tsconfig/plugins, installs dependencies, or reads host files.
 * This is a module dependency approximation, not a semantic call/reference graph.
 */
import ts from 'typescript';
import { posix } from 'node:path';
import { z } from 'zod';

const repositoryPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes(':') &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every((part) => part !== '.' && part !== '..' && part !== ''),
  );
export const sourceSnapshotSchema = z.strictObject({
  tenantId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  complete: z.boolean(),
  files: z
    .array(
      z.strictObject({ path: repositoryPath, source: z.string().max(262144) }),
    )
    .max(100),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export interface GraphSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
}
export interface GraphModule {
  path: string;
  symbols: GraphSymbol[];
  imports: string[];
  exports: string[];
}
export interface GraphGap {
  path?: string;
  code: string;
}
export interface ModuleGraph {
  tenantId: string;
  repositoryId: number;
  sha: string;
  modules: GraphModule[];
  edges: { from: string; to: string; specifier: string }[];
  coverageGaps: GraphGap[];
  complete: boolean;
}
const extensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** Resolve only relative paths in the supplied snapshot, never on the host disk. */
function candidates(from: string, specifier: string) {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (joined.startsWith('../') || joined === '..') return [];
  const stem = joined.replace(/\.(mjs|cjs|js|jsx)$/, '');
  // TS often imports emitted .js while the source is .ts; ambiguity is a gap,
  // rather than guessing tsconfig resolution order or package export conditions.
  return [
    ...new Set([
      joined,
      ...extensions.map((ext) => stem + ext),
      ...extensions.map((ext) => posix.join(joined, 'index' + ext)),
    ]),
  ];
}

export function buildModuleGraph(snapshotInput: SourceSnapshot): ModuleGraph {
  const snapshot = sourceSnapshotSchema.parse(snapshotInput);
  if (
    snapshot.files.reduce(
      (sum, item) => sum + Buffer.byteLength(item.source),
      0,
    ) > 2097152
  )
    throw new Error('graph_source_budget');
  if (snapshot.files.some((item) => Buffer.byteLength(item.source) > 262144))
    throw new Error('graph_file_budget');
  const paths = new Set(snapshot.files.map((item) => item.path));
  if (paths.size !== snapshot.files.length)
    throw new Error('graph_duplicate_path');
  const graph: ModuleGraph = {
    tenantId: snapshot.tenantId,
    repositoryId: snapshot.repositoryId,
    sha: snapshot.sha,
    modules: [],
    edges: [],
    coverageGaps: [],
    complete: false,
  };
  if (!snapshot.complete)
    graph.coverageGaps.push({ code: 'incomplete_snapshot' });
  for (const item of snapshot.files) {
    // Generated/declaration/vendor files are not parsed as application modules.
    if (
      /(^|\/)(node_modules|dist|generated)\//.test(item.path) ||
      /\.d\.[cm]?ts$|\.gen\.[jt]s$/.test(item.path)
    ) {
      graph.coverageGaps.push({
        path: item.path,
        code: 'generated_or_declaration',
      });
      continue;
    }
    if (!extensions.some((ext) => item.path.endsWith(ext))) {
      graph.coverageGaps.push({
        path: item.path,
        code: 'unsupported_language',
      });
      continue;
    }
    const source = ts.createSourceFile(
      item.path,
      item.source,
      ts.ScriptTarget.Latest,
      false,
      item.path.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : item.path.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : /\.[cm]?js$/.test(item.path)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    const module: GraphModule = {
      path: item.path,
      symbols: [],
      imports: [],
      exports: [],
    };
    graph.modules.push(module);
    // TypeScript's syntax diagnostics live on parser results rather than a full
    // Program. No semantic checker or repository CompilerHost is constructed.
    if (
      (
        source as ts.SourceFile & {
          parseDiagnostics?: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics?.length
    )
      graph.coverageGaps.push({ path: item.path, code: 'syntax_error' });
    const exportedLocals = new Set<string>();
    const addImport = (specifier: string) => {
      if (!module.imports.includes(specifier)) module.imports.push(specifier);
    };
    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement)
        ? ts.getModifiers(statement)
        : undefined;
      const exported =
        modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      const defaultExport =
        modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ??
        false;
      const addSymbol = (name: string, kind: string) => {
        module.symbols.push({
          name,
          kind,
          exported,
          line:
            source.getLineAndCharacterOfPosition(statement.getStart(source))
              .line + 1,
        });
        if (exported) module.exports.push(defaultExport ? 'default' : name);
      };
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
        addImport(statement.moduleSpecifier.text);
      if (ts.isExportDeclaration(statement)) {
        if (
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        )
          addImport(statement.moduleSpecifier.text);
        if (statement.exportClause && ts.isNamedExports(statement.exportClause))
          module.exports.push(
            ...statement.exportClause.elements.map(
              (element) => element.name.text,
            ),
          );
        else if (
          statement.exportClause &&
          ts.isNamespaceExport(statement.exportClause)
        )
          module.exports.push(statement.exportClause.name.text);
        else if (statement.moduleSpecifier) module.exports.push('*');
      }
      if (ts.isExportAssignment(statement)) module.exports.push('default');
      if (defaultExport && !module.exports.includes('default'))
        module.exports.push('default');
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      )
        for (const element of statement.exportClause.elements)
          exportedLocals.add((element.propertyName ?? element.name).text);

      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      )
        addSymbol(statement.name.text, ts.SyntaxKind[statement.kind]);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            addSymbol(declaration.name.text, 'variable');
          else
            graph.coverageGaps.push({
              path: item.path,
              code: 'destructured_symbol',
            });
        }
      if (ts.isImportEqualsDeclaration(statement)) {
        graph.coverageGaps.push({ path: item.path, code: 'import_equals' });
        const ref = statement.moduleReference;
        if (
          ts.isExternalModuleReference(ref) &&
          ref.expression &&
          ts.isStringLiteral(ref.expression)
        )
          addImport(ref.expression.text);
      }
      // Namespace bodies can contain dependencies outside the top-level model.
      if (ts.isModuleDeclaration(statement))
        graph.coverageGaps.push({
          path: item.path,
          code: 'namespace_declaration',
        });
    }
    for (const symbol of module.symbols)
      if (exportedLocals.has(symbol.name)) symbol.exported = true;
    module.exports = [...new Set(module.exports)];
    // Iterative traversal prevents our visitor from overflowing on deep nesting.
    // The parser itself still requires process-level limits for hostile inputs.
    const pending: ts.Node[] = [source];
    let visited = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (++visited > 50000) {
        graph.coverageGaps.push({ path: item.path, code: 'node_budget' });
        break;
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        graph.coverageGaps.push({
          path: item.path,
          code:
            node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? 'dynamic_import'
              : 'commonjs_dependency',
        });
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) addImport(argument.text);
      }
      ts.forEachChild(node, (child) => {
        pending.push(child);
      });
    }
  }
  const analyzable = new Set(graph.modules.map((module) => module.path));
  for (const module of graph.modules)
    for (const specifier of module.imports) {
      if (!specifier.startsWith('.')) {
        graph.coverageGaps.push({
          path: module.path,
          code: 'external_or_alias_import',
        });
        continue;
      }
      const resolved = candidates(module.path, specifier).filter((path) =>
        analyzable.has(path),
      );
      if (resolved.length === 1)
        graph.edges.push({ from: module.path, to: resolved[0], specifier });
      else
        graph.coverageGaps.push({
          path: module.path,
          code: resolved.length ? 'ambiguous_import' : 'unresolved_import',
        });
    }
  graph.coverageGaps = graph.coverageGaps.filter(
    (gap, index, all) =>
      all.findIndex(
        (other) => other.path === gap.path && other.code === gap.code,
      ) === index,
  );
  graph.complete = graph.coverageGaps.length === 0;
  return graph;
}

/** Reverse dependencies in BOTH snapshots retain consumers of renamed/deleted files. */
export function affectedModules(
  base: ModuleGraph,
  head: ModuleGraph,
  comparisonInput: {
    baseSha: string;
    mergeBaseSha?: string;
    headSha: string;
    complete: boolean;
    files: { filename: string; previous_filename?: string }[];
  },
) {
  if (
    base.tenantId !== head.tenantId ||
    base.repositoryId !== head.repositoryId
  )
    throw new Error('graph_scope_mismatch');
  const comparison = z
    .object({
      baseSha: z.string().regex(/^[a-f0-9]{40}$/),
      mergeBaseSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
      headSha: z.literal(head.sha),
      complete: z.boolean(),
      files: z
        .array(
          z.object({
            filename: repositoryPath,
            previous_filename: repositoryPath.optional(),
          }),
        )
        .max(300),
    })
    .parse(comparisonInput);
  // Compare changes are relative to the merge base, not necessarily the branch tip.
  if ((comparison.mergeBaseSha ?? comparison.baseSha) !== base.sha)
    throw new Error('graph_base_mismatch');
  const changes = comparison.files;
  const affected = new Set(
    changes.flatMap((change) =>
      change.previous_filename
        ? [change.filename, change.previous_filename]
        : [change.filename],
    ),
  );
  const reverse = new Map<string, Set<string>>();
  for (const edge of [...base.edges, ...head.edges]) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to)!.add(edge.from);
  }
  const pending = [...affected];
  while (pending.length)
    for (const consumer of reverse.get(pending.pop()!) ?? []) {
      if (!affected.has(consumer)) {
        affected.add(consumer);
        pending.push(consumer);
      }
    }
  const known = new Set(
    [...base.modules, ...head.modules].map((module) => module.path),
  );
  const unknownChanges = [...affected].some((path) => !known.has(path));
  const widened =
    !base.complete || !head.complete || !comparison.complete || unknownChanges;
  // Incomplete graphs widen to all supplied modules; absent snapshot files remain
  // unknown, so this result never claims complete repository-wide coverage.
  if (widened)
    for (const module of [...base.modules, ...head.modules])
      affected.add(module.path);
  return {
    modules: [...affected].sort(),
    widened,
    coverageGaps: [
      ...base.coverageGaps,
      ...head.coverageGaps,
      ...(!comparison.complete ? [{ code: 'incomplete_comparison' }] : []),
      ...(unknownChanges ? [{ code: 'unknown_changed_module' }] : []),
    ],
  };
}
