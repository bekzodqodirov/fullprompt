# docs/ai-toliq — working material of the «To'liq AI sotuvchi» design

The design itself is `docs/AI-SOTUVCHI-TOLIQ.md`. This folder is what it was made from, kept because the build
sessions will not have the session scratch it was written in. Nothing here is code and nothing here is built.

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

Paths inside these files that say «session scratch» point at material that was not kept.
