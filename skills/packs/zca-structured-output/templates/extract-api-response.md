# Extract API Response Template

This template demonstrates how to extract pricing data from a large API response and fold the
result into `zca_scope`, `zca_contract`, `zca_result`, `zca_validation`, and `zca_repair`.

## Input Example

```json
{
  "data": {
    "pricing": [
      { "plan": "Starter", "price": "9", "currency": "usd" },
      { "plan": "Pro", "price": 29, "currency": "USD" },
      { "plan": "Enterprise", "price": 99, "currency": "usd" }
    ]
  },
  "pagination": {
    "next": null
  },
  "meta": {
    "requestId": "req-123",
    "generatedAt": "2026-03-09T10:00:00Z"
  }
}
```

## Step 0: Scope Gate

```text
ZCA_SCOPE
- domain: "pricing extraction"
- included:
  - "api-response.json:data.pricing"
- excluded:
  - item: "pagination"
    reason: "not part of the pricing contract"
  - item: "meta"
    reason: "request metadata does not affect the output schema"
- reduction_estimate: "about 70%"
```

```text
ZCA_CONTRACT
- schema_summary:
  - "plans[].name:string"
  - "plans[].price:number"
  - "plans[].currency:string"
- invariants:
  - "price > 0"
  - "currency must be an uppercase ISO 4217 code"
- repair_budget: 2
- size_policy: "inline_summary"
```

## Step 1: Canonicalization

Normalization actions:

- keep only `data.pricing`
- map `plan` to `name`
- convert string prices to numbers
- normalize currency values to uppercase
- sort by `name`

Canonicalized candidate:

```json
{
  "plans": [
    { "name": "Enterprise", "price": 99, "currency": "USD" },
    { "name": "Pro", "price": 29, "currency": "USD" },
    { "name": "Starter", "price": 9, "currency": "USD" }
  ]
}
```

## Step 2: Validation

```bash
bun eval '
import Ajv from "ajv";

const schema = {
  type: "object",
  required: ["plans"],
  properties: {
    plans: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "price", "currency"],
        properties: {
          name: { type: "string" },
          price: { type: "number" },
          currency: { type: "string", pattern: "^[A-Z]{3}$" }
        }
      }
    }
  }
};

const data = {
  plans: [
    { name: "Enterprise", price: 99, currency: "USD" },
    { name: "Pro", price: 29, currency: "USD" },
    { name: "Starter", price: 9, currency: "USD" }
  ]
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const ok = validate(data);

const invariantErrors = data.plans
  .filter((plan) => plan.price <= 0)
  .map((plan) => ({ rule: "price > 0", actual: plan.price, name: plan.name }));

if (!ok || invariantErrors.length > 0) {
  console.error(JSON.stringify({
    category: !ok ? "schema_mismatch" : "invariant_violation",
    schemaErrors: validate.errors ?? [],
    invariantErrors
  }));
  process.exit(1);
}

console.log("VALID");
'
```

```text
ZCA_VALIDATION
- verdict: pass
- validator: "bun eval + ajv"
- failure_category: none
- evidence: "VALID"
```

## Step 3: Repair Example

If the first model candidate were:

```json
{
  "plans": [
    { "name": "Starter", "price": "9", "currency": "USD" }
  ]
}
```

then repair should target only the failing field rather than rerunning the full extraction:

```text
REPAIR_DIAGNOSTIC
- attempt: 1
- failure_type: schema_mismatch
- failing_fields:
  - field: "/plans/0/price"
    expected: "number"
    actual: "\"9\""
- repair_strategy: "convert string price fields to numbers and rerun the validator"
```

After a successful repair, the final repair summary should be:

```text
ZCA_REPAIR
- total_attempts: 1
- outcome: repaired
- last_diagnostic: "converted string price fields to numbers"
```

## Final Completion Payload

```json
{
  "zca_scope": {
    "domain": "pricing extraction",
    "included": ["api-response.json:data.pricing"],
    "excluded": ["pagination", "meta"],
    "reduction_estimate": "about 70%"
  },
  "zca_contract": {
    "schema_summary": [
      "plans[].name:string",
      "plans[].price:number",
      "plans[].currency:string"
    ],
    "invariants": [
      "price > 0",
      "currency must be an uppercase ISO 4217 code"
    ],
    "repair_budget": 2,
    "size_policy": "inline_summary"
  },
  "zca_result": {
    "status": "validated",
    "data_summary": "3 plans extracted",
    "artifact_ref": null
  },
  "zca_validation": {
    "verdict": "pass",
    "validator": "bun eval + ajv",
    "failure_category": "none",
    "evidence": "VALID"
  },
  "zca_repair": {
    "total_attempts": 0,
    "outcome": "not_needed",
    "last_diagnostic": "validation passed on the first attempt"
  }
}
```

If the payload is too large, write the full result to a temporary artifact and reduce `zca_result`
to a summary plus `artifact_ref`.
