# Application pattern review

This review weighs application patterns against the library's consumer-control, schema-mapping, laziness and Effect
composition principles. It records implementation choices, not additional owner-confirmed policies.

The source review inspected TaqsWeb's `pre-effect` revision `fc589227473700753319c0837834fa8fd945fd19`, especially its
creation/update operations, Location identifier extraction and table provider. Its active checkout remained on `main`;
files were read from the branch with `git show`. No proprietary implementation was copied into these recipes.

| Pattern                                             | Assessment and placement                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Interaction cancellation and presentation ownership | Covered by the gate and frontend tutorial; no additional control methods needed                                   |
| Business response interpretation and retention      | Compose Effect failure handling and `shouldCache`; notifications belong to the presentation owner                 |
| Pagination metadata and header-first identifiers    | Adopted as tested metadata recipes, using existing codecs and schema composition                                  |
| Create plus attachment upload                       | Adopted as a tested operation recipe with checkpoints, upload-only recovery and structured interruption           |
| Encoded-model diff and unchanged saves              | API-specific: patch format, removals, arrays, revision checks and equality need the service's contract            |
| Typed search grammar                                | Use optional query schemas and pure service-specific serializers; do not impose a Boolean AST or array convention |
| Form cleanup                                        | Field-specific schema transformations; no global omission of null, empty text or array elements                   |
| Service discovery                                   | Consumer configuration/service composition; startup topology policy is not an HTTP-plan responsibility            |
| Binary-to-browser File conversion                   | Browser adapter over bytes and response metadata; retain Node-compatible finite codecs in the core                |

The metadata recipe addresses concrete gaps in the example coverage: strict header validation, response normalization,
and body ownership during a header/body fallback. These capabilities compose without a new envelope-mapping DSL or
mandatory response-header convention. See [recipes](recipes.md) for the executable implementation and limitations.

The attachment workflow addresses the creation/upload failure boundary without introducing a generic transaction or
workflow framework. Its application-owned progress Ref and typed upload failure retain completed work; its upload-only
resume path avoids reissuing creation. A service-specific idempotent attachment replacement contract handles ambiguous
upload acknowledgement. Automatic rollback, generic JSON Patch construction and global form cleanup are deliberately
not extracted: the necessary semantics differ across APIs, and existing Effect/schema composition supplies the useful
building blocks without making those policies universal.
