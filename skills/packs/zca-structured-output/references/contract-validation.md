# Contract Validation

## Intent

Validation converts "this structured output looks reasonable" into a deterministic pass or fail result.

In this skill, the only supported validation path is:

- `exec`
- `bun eval`
- `ajv`

Do not mix in `jq`, ad hoc validation, or narrative-only judgment in v1.

## Validation Inputs

At minimum, validation needs:

- a schema document
- a candidate output
- an invariant set

If the schema or candidate is large, place the full content in a temporary artifact and keep only
a summary plus `artifact_ref` in the final skill outputs.

## Reference Validator

```bash
bun eval '
import Ajv from "ajv";

const schemaPath = Bun.argv[2];
const dataPath = Bun.argv[3];

if (!schemaPath || !dataPath) {
  console.error(JSON.stringify({ category: "tool_failure", reason: "missing_paths" }));
  process.exit(1);
}

const schema = JSON.parse(await Bun.file(schemaPath).text());
const data = JSON.parse(await Bun.file(dataPath).text());

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const schemaOk = validate(data);

const invariantErrors = [];

// Example invariant check - adapt to the actual contract invariants.
if (Array.isArray(data?.plans)) {
  for (const [index, plan] of data.plans.entries()) {
    if (typeof plan?.price === "number" && plan.price <= 0) {
      invariantErrors.push({
        path: `/plans/${index}/price`,
        rule: "price > 0",
        actual: plan.price
      });
    }
  }
}

if (!schemaOk || invariantErrors.length > 0) {
  console.error(
    JSON.stringify({
      category: !schemaOk ? "schema_mismatch" : "invariant_violation",
      schemaErrors: validate.errors ?? [],
      invariantErrors
    })
  );
  process.exit(1);
}

console.log("VALID");
' "$schema_path" "$data_path"
```

## Failure Categories

Use exactly these failure categories:

- `schema_mismatch`
- `invariant_violation`
- `parse_error`
- `timeout`
- `tool_failure`

Classification rules:

- schema rejection -> `schema_mismatch`
- schema pass but invariant failure -> `invariant_violation`
- malformed JSON input -> `parse_error`
- timed-out `exec` run -> `timeout`
- command, dependency, path, or parameter failure -> `tool_failure`

## Evidence Policy

Validation evidence should live in:

- raw `exec` output
- `zca_validation` inside `skill_complete`

Do not depend on `truth_upsert`, because it is not part of the default tool surface used here.

Recommended `zca_validation` fields:

- `verdict`
- `validator`
- `failure_category`
- `evidence`

`evidence` should contain only key lines, a short failure summary, or an artifact summary. Do not
inline full validator output.

## Size Policy

Do not place the following directly in required outputs:

- the full schema
- the full candidate JSON
- the full error array

Prefer:

- schema summaries
- failure counts
- the first failing path
- artifact references

## Anti-Patterns

- treating model confidence as validation
- explaining schema failure narratively without keeping machine-readable failure data
- maintaining multiple validator paths for the same contract
- writing large objects directly into `zca_result`
