# Payroll Pipeline — October 2026

An automated payroll system built on **n8n + Google Sheets + Apps Script**, with a companion **ticket-processing pipeline** that answers employee payroll questions. This document describes how it works, what it produced for October 2026, and how to run it.

## Overview

The solution has two parts:

| Part | What it does | Output |
|------|--------------|--------|
| **A — Payroll calculation** | Reads source data from a Google Sheet, calculates October 2026 payroll for every employee, flags data-quality problems, and reconciles the result against HR's manual calculation | `payroll_oct_result` tab |
| **B — Ticket processing** | Takes employee questions ("why is my payout lower than expected?"), checks them against Part A's results, routes them to the right team, and drafts a reply | `tickets_oct_result` tab |

Everything runs in **n8n** (orchestration) with the calculation engine deployed as a **Google Apps Script Web App**. The LLM (gpt-5-mini via n8n Gateway) is used only for understanding free-text tickets and writing reply drafts — never for money math.

---

## Part A — Payroll calculation

### How it works

```
Google Sheet (4 source tabs)
   → n8n: read tabs, package into one JSON
   → Apps Script engine (Payroll_calc.gs):
       1) validate ALL source rows first — problems are flagged, and
          unreliable data blocks that employee's calculation
       2) calculate pay for employees whose data is clean
       3) reconcile the result against HR's manual figures
   → n8n: write results to the payroll_oct_result tab (with formatting)
```

The engine implements eight payroll rules exactly as specified: contract-type-based pay (monthly salary / hourly / per-lesson), mid-month proration on **computed** working days (Mon–Fri, never a hardcoded constant), employment-window enforcement, adjustments, fixed FX rates, country-specific withholding, platform-fee rules (including the FTE "company pays" case), and rounding only at the very end.

Validation runs **before** any money is computed: all four source tables are checked in one pass, and an employee whose source data has a critical error (a conflicting duplicate import, an invalid date, a missing currency…) gets **no calculated sums** — their row still appears, carrying the reasons, so nobody pays from numbers the engine doesn't trust. Every row ends with a clear status: **OK**, **WARNING** (review advised; figures still calculated) or **CRITICAL** (unreliable — resolve before paying).

**All money math is deterministic code** — auditable, reproducible, and immune to hallucination. The engine lives in a single file (`Payroll_calc.gs`).

### Data-quality flags

Anything suspicious in the inputs is **flagged with a reason — never silently fixed, never silently ignored**. Every employee always appears in the result table, even when their calculation is blocked.

| Flag | Example from October | Effect |
|------|---------------------|--------|
| Duplicate import (identical) | E04's row imported twice | paid once, duplicate flagged |
| Duplicate import (conflicting) | — | calculation **blocked** until corrected |
| Activity outside employment | E08: 6 h logged after her end date | excluded from pay |
| Activity referencing an unknown employee | E11's lesson import has no employee record | not paid; reported in a separate global flag list (no payout row) |

Around **40 checks** back this up — invalid or inverted dates, unknown currencies, missing rates or payout methods, activity imported from the wrong system for the contract type, negative units, duplicate employee IDs, cross-currency adjustments, hours above the monthly working-hours cap (hourly staff are capped at 8 h × working days = 176 h in October, and the capped row is flagged) — and more. HR's manual sheet is validated too: rows must reference real employees with non-negative numeric values, **all** duplicate rows are compared rather than just the first, and a missing row is flagged critical instead of passed over.

### Reconciliation against HR's manual calculation

October 2026 result: **6 matches, 4 mismatches — all four in the engine's favor.** HR's manual figures overstate payable net by **$3,895.49** in total.

| Employee | Engine net (USD) | Manual net | What HR missed |
|----------|-----------------|------------|----------------|
| Marko (E02) | **1,484.51** | 2,721.60 | Started Oct 15 — manual paid a full month instead of 12/22 working days |
| Sofia (E04) | **2,327.80** | 4,660.60 | Manual double-counted a duplicated hours import (240 h vs 120 h real) |
| Diego (E05) | **1,038.80** | 1,234.80 | Manual ignored a −$200 advance deduction |
| Julia (E08) | **1,463.80** | 1,593.40 | Manual paid 6 hours logged after her employment end date |

Each mismatch carries a human-readable reason in the result table (e.g., *"manual gross reflects an unprorated period; the engine prorates pay when employment covers only part of the period"*), assembled from stable templates so the wording stays consistent across periods.

Disagreements never stay quiet: a gross or net difference becomes a **critical** flag spelling out both figures and the direction (*"manual overpays by 2,332.80 — resolve before paying"*); if the money agrees but the withholding or fee components don't, that's a **warning** for review. Every row also records who appears to be right — **BOTH** (figures agree), **ENGINE_PER_RULES** (the engine follows the stated payroll rules; the manual figures don't) or **UNRESOLVED** (the engine couldn't calculate) — and includes a plain-language calculation trace such as *"2800 EUR (salary) x 12/22 working days = 1527.27 EUR x 1.08 (FX to USD) = 1649.45 USD gross - 164.95 USD (withholding) = 1484.51 USD net"*, so anyone can verify the math without reading code.

### Result table formatting

Applied automatically on every run: rows where the engine agrees with the manual calculation are painted **light green**, the used range gets **solid borders**, and the formatting self-heals (stale rules are removed before re-adding).

---

## Part B — Ticket processing

### How it works

```
Ticket ("My payout is $200 less than expected — is something wrong?")
  → Security scan (before any LLM call)
  → LLM extracts structure (category, amounts, hours, dates)
  → Output validation (strict schema)
  → Deterministic routing + claim check against Part A results
  → LLM drafts a friendly employee reply (caged prompt)
  → Draft validation (no numbers, no internal details)
  → Result written to tickets_oct_result
```

### Security: three gates around the LLM

1. **Input scan** — regex heuristics on the raw ticket *before* any model call: instruction-override attempts, fake system messages, role reassignment, approval requests, hidden characters. A blocked ticket never reaches an LLM and gets a simple standard reply ("Thank you for your message — unfortunately, it cannot be answered.").
2. **Extraction validation** — the model's structured output is checked against a strict contract: exact field set, enum categories, types, date formats, and no instruction-like text smuggled into model fields. A malformed extraction falls back to the standard reply.
3. **Draft validation** — the generated reply must contain **zero digits** (the strongest possible "no money figures" guarantee), no internal terminology (engine, flags, rules, ticket IDs), one paragraph, sane length. Any violation → the deterministic template takes over.

The LLM **never sees** the raw ticket text in the drafting step — only the employee's first name and a communication goal. It cannot change any number and cannot leak internal details it was never given.

### Routing policy (deterministic code, never the LLM)

In order:

1. **Question about another employee's pay → AUTO_REPLY** with a polite privacy refusal.
2. **Payroll question where every amount the employee mentions matches their payroll row** (within a 1-cent tolerance) **→ AUTO_REPLY** — it's a clarification about FX, rounding, or fee display, not a dispute. This holds even if the LLM flagged a money-change request or the engine/manual reconciliation disagrees on other components.
3. **Payroll question with a genuine engine/manual mismatch → FINANCE** (never auto-answered when money is disputed).
4. **Money-change request → FINANCE** (recalculation demands, "add lessons to my total").
5. **Payout arrangement change → HR** (switching Payoneer to Wise — affects fees only indirectly).
6. Anything else → **HR**.

Rule 2 is what makes the system feel smart: an employee who says *"my rate is 1,100 RSD × 64 lessons = 70,400 RSD but I received $647.68 — where did the rest go?"* is citing **correct** numbers (the difference is just the RSD→USD conversion), so they get an immediate reassuring reply instead of an unnecessary Finance escalation.

### The reply drafts

Always employee-facing, regardless of internal routing: warm, first-name greeting, natural phrasing, **no figures, no internal details, no retelling of the employee's story**. Blocked tickets keep a one-line standard reply. A few real examples (AI-drafted):

> *"Hi Diego, I looked into your October payout question and have passed it on to our payroll specialists, who will be in touch shortly to help."*

> *"Hi Nikola, I've double-checked your October payout and everything looks correct. If anything still feels off, just reply here — I'll gladly take another look."*

> *"Hi Nikola, I'm afraid we can't share payroll details of other employees — but if anything about your own October payout is unclear, I'm happy to help."*

### Result table

16 columns per ticket: identity, validation status, extracted claim summary, mentioned amounts/hours/dates, routing decision, the drafted reply, and processing notes (why it was routed there). Formatting: grey bold header, solid borders, zebra-striped rows — all self-healing on every run.

### LLM cost

Measured from live-run telemetry: **~1,200 tokens per ticket** (≈900 for extraction, ≈300 for the reply draft). Injection-blocked tickets cost zero tokens. Budget caps per day/month can be set at the workflow level, with automatic fallback to template replies when exceeded.

---

## Running the pipelines

### Prerequisites

- An n8n instance (cloud or self-hosted) with a **Google Sheets OAuth credential** (edit access to the payroll spreadsheet)
- The Apps Script engine (`Payroll_calc.gs`) deployed as a **Web App**: in the spreadsheet → Extensions → Apps Script → paste the file → Deploy → New deployment → Web app (Execute as: Me, access: Anyone) → copy the URL into the workflow's HTTP node
- The LLM runs on **n8n Gateway credits** — no OpenAI key needed; alternatively point the model node at your own credential

### Changing the period

All period settings (year, month, FX rates, fee caps, withholding rules) live in `PAYROLL_CONFIG` at the top of `Payroll_calc.gs`. Working days — and everything derived from them, including the hourly hours cap (8 h × working days) — are always computed from the calendar. For the next month: update the config, redeploy the Web App, add the new source tabs, run both workflows.

---

## Design principles

1. **Money math is code, not AI.** Every dollar figure comes from deterministic rules. The LLM only reads and writes language.
2. **Flag, never silently fix.** Data problems get a reason attached and stay visible in the result table — and when the data is unreliable, the calculation is blocked rather than guessed.
3. **Nothing disappears.** Every employee gets a result row; every ticket gets a reply draft; references that belong to no employee (orphans) are reported in a separate global flag list instead of silently vanishing.
4. **The LLM is caged.** It sees the minimum data needed (first name + goal), its output is validated, and every gate has a deterministic fallback.
5. **Employee-facing messages are kind and safe.** First-name greetings, no figures, no internals, no story-retelling — verified by a zero-digit check on every AI draft.
