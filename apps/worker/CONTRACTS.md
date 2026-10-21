# OpenAPI contract validation

Part 4.1 adds `validateApiContract(context, text)` in `src/openapi.ts`. Supply an independently authorized tenant UUID, repository ID, immutable head SHA and bounded operator-selected contract text. Context format errors throw; document problems return fixed diagnostics. No filesystem/HTTP contract loader or customer endpoint is exposed.

The result retains the supplied context and a SHA-256 digest of the original text. Its status is `supported`, `invalid`, `unsupported` or `unavailable` (an internal processing failure). Only `supported` returns normalized operations and security scheme metadata. Every other status returns empty operations and schemes plus one fixed diagnostic code. Raw parser/Ajv errors, source text, descriptions and example values are never included in diagnostics. This is validation of an explicit testing profile, not certification of complete OpenAPI conformance or proof that a schema is satisfiable.

## Supported profile

- OpenAPI versions 3.0.0 through 3.0.4, supplied as one JSON or YAML 1.2 document with unique string keys. Ajv validates the bundled [OpenAPI document schema](https://github.com/APIDevTools/openapi-schemas) using [draft-04 support](https://ajv.js.org/json-schema.html#draft-04); it never compiles customer Schema Objects or loads referenced resources.
- Literal and templated relative paths, standard HTTP methods, unique operation IDs when supplied, and explicit numeric responses, `1XX` through `5XX` ranges or `default`. Path variables require matching mandatory path parameters. These are operation labels, not authorized URLs or instructions to send requests.
- Local `#/components/...` references to schemas, parameters, request bodies, responses and security schemes. Targets must exist in the expected component category. Acyclic reuse is allowed; cycles, remote/file/relative-document refs, encoded refs and Path Item refs are rejected. Unused declared schemas/parameters/bodies/responses also undergo profile checks.
- Typed object, array, string, integer, number and boolean schemas; nullable values, primitive enums, required properties, additional-property rules, array items, numeric/length/count bounds, exclusivity, multiples and uniqueness. Regex patterns receive a bounded JavaScript syntax check but are never matched against data here. Preservation of a pattern is not proof it is safe for later matching.
- Primitive path/query/header/cookie parameter schemas with default `simple` or `form` serialization. Operation parameters override matching Path Item parameters; header names match without case. Explicit `explode` is preserved. The ignored `Accept`, `Content-Type` and `Authorization` Header Parameter definitions are unsupported instead of becoming fuzz inputs.
- Exactly `application/json` request/response content with a supported schema. A response without content retains an explicit status expectation without inventing a body schema. Request-body requiredness is retained.
- HTTP bearer/basic and API-key security metadata. Global security is inherited unless the operation overrides it. AND requirements, OR alternatives, an anonymous `{}` alternative and `security: []` remain distinct. Unknown schemes and nonempty scopes for these scheme types are rejected. Metadata does not contain tokens, grant credentials or assert that an operation is authorized.

Unsupported profile features include OpenAPI 2/3.1/3.2, OAuth/OpenID, composed or untyped schemas, `format`, directional `readOnly`/`writeOnly`, XML/discriminator semantics, recursive schemas, structured parameter serialization, callbacks, response headers/links and multi-media/non-JSON content. Valid features outside the profile produce `unsupported`; malformed documents or detected semantic contradictions produce `invalid`. A single unsupported feature prevents returning a partially weakened inventory.

The profile follows the [OpenAPI 3.0 reference, parameter, security and schema rules](https://spec.openapis.org/oas/v3.0.3.html). It intentionally supports fewer features. Selected annotation formats such as metadata URLs are not validated because they are discarded, not executed. Defaults/examples, descriptions, server URLs and vendor extensions do not enter the normalized inventory. Enum values, patterns, parameter names and paths remain untrusted contract data and may be sensitive; this is not a generic secret scrubber or a safe rendering format.

## Limits and trust boundaries

| Boundary                                                | Ceiling                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Original UTF-8 text                                     | 256 KiB                                                            |
| Parsed syntax tree                                      | 10,000 nodes, depth 40                                             |
| Individual scalar                                       | 32,768 characters; finite safe integers                            |
| Components                                              | 200 entries per category; 100-character component names            |
| Paths and operations                                    | 100 paths, 200 operations                                          |
| Parameters                                              | 50 per declared list                                               |
| Schema shape                                            | 100 properties per object, 100 enum values, 256-character patterns |
| Schema/reference expansion                              | 5,000 work units; depth 20                                         |
| Expanded scalar schema metadata / normalized operations | 1 MiB each                                                         |

YAML aliases, anchors, explicit tags, duplicate/non-string keys, reserved prototype/merge keys, non-finite numbers and unsafe integer values are rejected before conversion. See the [YAML parser documentation](https://eemeli.org/yaml/) for its document/error APIs. No includes, custom tag handlers, URL resolution or filesystem resolution is configured.

Size and expansion ceilings prevent unbounded output but do not enforce a process CPU deadline or isolate the parser. Before processing hostile customer documents in production, a supervisor must supply enforced memory/time limits, bound loading before constructing the text, revalidate ownership/current SHA, and handle cancellation. Normal startup still dispatches only, so this phase introduces no automatic customer parsing.

Contract `servers` URLs never select a target, including loopback/metadata URLs in the synthetic fixture. Future request execution must use a separately authorized exact-SHA preview and enforce egress, synthetic-account authority, rate/request/payload budgets and cleanup. Case generation/ranking comes in Phase 4.2; execution and limits come in Phase 4.3. No missing-contract discovery, API request, authentication probe, response-data validation, finding or pass verdict is produced here.

## Verification

The worker unit suite loads PawMart's actual YAML contract and verifies both operation inventories, schema references and inherited bearer requirements without contacting its server. Synthetic cases cover JSON/YAML failures, reference safety and cycles, required path parameters, operation overrides, security alternatives, unsupported constraints, metadata omission and expansion limits. Existing CI runs this suite through `npm test`; no browser, data service, live token or new verifier command is needed for this phase.
