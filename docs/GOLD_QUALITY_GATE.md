# Gold Quality Gate

## Artifact Location

Gold answers are stored in:

- `packages/eval/gold/gold-answers.json`
- `packages/eval/gold/gold-answers.md`
- `packages/eval/gold/gold-answers.example.json`
- `packages/eval/gold/gold-answers.schema.json`

The user provided the initial gold answer content in the build prompt. It must not be overwritten with invented benchmark claims.

## Required Format

Each gold question record must include:

- `id`
- `category`
- `query_types`
- `question`
- `gold_answer`
- `must_hit_atomic_facts`
- `required_source_types`
- `penalize_if`
- `methodology_notes`

## Parser / Validator Behavior

- JSON artifacts are validated with Zod.
- Markdown artifacts can be parsed into a draft JSON shape, but valid scoring requires the JSON artifact.
- Invalid or missing gold artifacts mark comparisons as `blocked_missing_gold` or `blocked_invalid_gold`.

## Benchmark Status Rules

- Valid scoring requires validated gold answers.
- Custom user queries are marked `scoring_unavailable`, not failed.
- Opponent results may be `live`, `imported`, `manual`, or `missing`.
- Imported/manual opponent results are never labeled as live.

## Scoring Philosophy

The harness scores claim-level usefulness:

- facts hit
- required source types hit
- primary-source coverage
- hallucination flags
- contested or unsourced claims
- token efficiency
- time to result

The benchmark does not reward prose that merely sounds like the gold answer.

## No Fake Benchmark Claims

The system must not fabricate:

- citations
- opponent runs
- benchmark wins
- live API availability
- domain-expert validation

Q3 and Q4 are treated as domain-depth gates. Shallow crash summaries or generic "Bloomberg plus low latency" answers should score poorly even if they are fluent.
