# Shared packages

## Contracts — Phase 1.2

`contracts` contains runtime schemas, inferred TypeScript types, and a pure opt-in evaluator. Its documented source explains each boundary. It is intentionally not yet imported by ingress or the worker: those applications have no webhook or job consumers until later phases.

### Configuration explained

- `package.json`: `private` prevents accidental publishing; `type: module` enables ESM imports. `exports` exposes generated JavaScript and declaration types through one package entry point. `build` emits these files, `typecheck` validates production source without emitting it, and `test` runs TypeScript behavior tests through tsx and Node's built-in runner.
- `tsconfig.json`: inherits strict root settings. `NodeNext` models Node ESM resolution, `rootDir` and `outDir` separate source from generated output, and `declaration` emits reusable types. Tests are excluded from production output and executed separately by the test runner.
- Root `test` script runs tests in workspaces that define a test command. No API or website tests are claimed by this command yet.

Database, analysis, and reporting packages will be created when their first consumers need them.

## Database — Phase 1.4

See [database setup](database/README.md) for local Postgres/Redis, schema ownership, migrations, generated files, and verification. The package is available to future consumers but is not wired into the application shells.
