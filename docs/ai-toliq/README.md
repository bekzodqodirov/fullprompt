# docs/ai-toliq — working material and build plans of the «To'liq AI sotuvchi»

The design itself is `docs/AI-SOTUVCHI-TOLIQ.md` (§11 = the owner's answers of 2026-11-20, binding); how the build
is run is `docs/AI-SOTUVCHI-TOLIQ-QURISH.md`. This folder is what the design was made from, kept because the build
sessions will not have the session scratch it was written in — and, in `qurish/`, the plans to build from. Nothing
here is code and nothing here is built.

**Start in `qurish/`** if you are building:

- `qurish/STAGE-0-1A.md`, `STAGE-1B-1C.md`, `STAGE-2.md`, `STAGE-3A.md`, `STAGE-3B.md`, `STAGE-4-6.md`,
  `STAGE-7-9.md` — one build plan per stage of the road, each against the code at the HEAD it names: what the stage
  is and is not, the data, the kernel and packages with the functions they change, law 4 and the leak fences, the
  prompt and gate, the tests with their red proofs, the order of work, the deploy list, the owner's questions.
  `⟨1a⟩`, `⟨1b⟩` … mark something an EARLIER stage builds: re-read it as built before leaning on it.
- `qurish/COVERAGE.md` — every answer traced to the stage that builds it (§A), the binding corrections and where
  each is held (§B), the names the plans share — one designation table, one conversation record, one rights table,
  the CHECKs widened once (§C), the ONE numbered list of questions for the owner (§E) and the first message to send
  him (§F).
- `qurish/_verify-refs-a.md`, `_verify-refs-b.md` — the record of the reference pass (what the code contradicted).

The rest is the design's working material:

- `map-*.md` — three maps of the code as of 2026-11-19 (the run and every wait reason; the whole sale as service
  doors; media, readers and cost plumbing).
- `design-*.md` — three independent designs (product, risk, operations). They disagree on the guard; the ruling is
  in the main document §3.
- `SPEC-TOLIQ-v1.md` — the first synthesis, superseded.
- `critic-*.md` — six critiques of v1. `critic-feasibility.md` §A lists the 35 earlier answers of the owner the
  design touches; `critic-guard.md` §C.2 is the measurement protocol that must run before any word rule is deleted;
  `critic-stt.md` §4 is the speech trial; `critic-telegram.md` §6 the Chat Automation trial.
- `cost-model.py` — the arithmetic behind `critic-cost.md` (prices from the code's own map; nothing measured).
- `corpora/customer-safety/cases*.json` — the 303 dangerous first-reply cases of DECISIONS #1619.
  When `critic-guard.md` was written they existed only in session scratch; they were copied here the same day so the
  exam of §3 has its cases. The 898-case reader corpus is already in `tests/unit/fixtures/agent-reader-corpus.ts`.
- `toliq-ai-sotuvchi.html` — the page shown to the owner (Uzbek; body content as published).
- `SPEC-P3-draft.md` — the earlier draft of «part 3» (the Friday greeting and the AI as its own seat), written
  before this design; stage 8's plan supersedes it, kept for the reasoning.

Paths inside these files that say «session scratch» point at material that was not kept.
