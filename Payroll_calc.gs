/**
 * Payroll engine + Web App — period: October 2026 (configurable below).
 *
 * Architecture (validate -> calculate -> reconcile):
 *   1. validateSources(): ALL source-data validations in one place, before any
 *      money is computed. Any critical error in an employee's source data
 *      (employees + activity + adjustments rows for that employee) blocks the
 *      calculation entirely: the row is still emitted into payout_oct with
 *      empty sums, all reasons concatenated and status CRITICAL. Rows that
 *      reference employees which do not exist never enter payout_oct — they
 *      are reported in the global flag list only (input tables may contain
 *      orphans; our output may not).
 *   2. buildPayrollRow(): payroll per rules 1-8 for every employee without
 *      critical source errors, plus a human-readable calculation trace
 *      (own column; also appended to mismatch reasons vs manual payroll).
 *   3. reconcile(): engine vs manual_payroll on gross AND net. Any difference
 *      is critical (over-/underpayment); gross/net agreement with differing
 *      withholding/fee components is a warning. Both need review.
 *
 * Row status = max severity of all flags: CRITICAL > WARNING > OK
 * (info flags do not raise the status). CRITICAL additionally means the
 * engine could not (or did not) compute reliable sums for the row.
 *
 * Rules implemented (from the task statement):
 *  1. Base pay in contract currency: FTE_MONTHLY = monthly salary;
 *     HOURLY = rate x approved hours (SolidTime); PER_LESSON = rate x lessons (Dash).
 *  2. FTE starting/leaving mid-month: salary x worked working days / working days
 *     in the month (start_date == end_date counts as 1 working day). Working
 *     days = Mon-Fri, no public holidays (computed from the calendar, never
 *     a constant).
 *  3. Activity outside [start_date, end_date] is not paid. Rows entirely
 *     outside the payable window (employment ∩ payroll month) are excluded;
 *     partially overlapping rows are paid in full (rule application, not an
 *     error — if manual disagrees, the reconciliation mismatch flags it).
 *     Activity rows must carry valid, ordered period dates: missing/malformed
 *     dates or period_from > period_to block the employee's calculation;
 *     rows spanning a month boundary are paid in full and flagged.
 *  4. Adjustments (bonuses, advance deductions) are added to base pay in the
 *     currency stated in the adjustments file (cross-converted via period FX
 *     when it differs from the contract currency).
 *  5. FX to USD fixed for the period: 1 EUR = 1.08 USD, 1 RSD = 0.0092 USD.
 *     gross_usd = (base + adjustments) x FX.
 *  6. Withholding: FTE_MONTHLY with country RS -> 10% of gross USD. Nobody else.
 *  7. Platform fee on gross USD: Payoneer 2% capped at $30; Wise $5 flat; bank $0.
 *     Deducted from the payout for HOURLY and PER_LESSON; for FTE_MONTHLY the
 *     company pays it (not deducted). Unknown/blank payout method is a
 *     critical validation error (the fee cannot be computed reliably).
 *  8. net_usd = gross - withholding - deducted fee. Rounded to 2 decimals only
 *     at the end (full precision in intermediates).
 *
 * HOURLY hours cap: approved hours are capped at hoursPerDay x working days
 * in the month (8 x 22 = 176 for October 2026); capped rows get a warning.
 * PER_LESSON is never capped (lesson duration is unknown). Weekend work is
 * unrestricted for HOURLY/PER_LESSON — only the HOURLY monthly total is
 * capped; Mon-Fri logic otherwise applies to FTE proration only.
 *
 * Data-quality policy: anything suspicious is flagged with a reason — never
 * silently fixed and never silently ignored. Number/locale formatting is
 * normalised upstream (Google Sheets / n8n deliver raw values), so the engine
 * only handles plain numbers and simple decimal-comma strings. Every flag
 * code and its severity are defined once in FLAG_DEFS; makeFlag refuses
 * unknown codes. Flags that belong to no employee row (orphans, manual rows
 * without an id) are returned in the global flag list instead of being
 * dropped.
 *
 * Duplicate policy (strict): identical duplicate import rows are deduplicated
 * (paid once) and always flagged; conflicting duplicates (any field differs —
 * formatting differences do not count) block the employee's calculation and
 * are always flagged.
 *
 * Slack IDs: payroll logic keys on employee_id only. slack_user_id stays in
 * the output (Part B tickets reference it) and duplicate slack IDs are
 * flagged as warnings because ticket routing depends on the mapping being
 * unique; a missing slack ID never blocks a calculation.
 *
 * Manual payroll comparison: gross AND net must match. Missing manual row for
 * a calculable employee -> critical "missing employee payroll calculation"
 * with manual figures shown as 0. Duplicate manual rows that all agree with
 * the engine -> warning; any disagreeing row -> critical mismatch. Manual
 * rows with non-numeric or negative values are flagged critical and excluded
 * from comparison.
 *
 * Reconciliation policy: mismatches are classified into generic finding codes
 * (see RECONCILIATION_REASONS); the reason text is assembled from those
 * templates. Escalation: gross/net difference -> critical; component-only
 * difference (withholding/fee) with agreeing gross/net -> warning.
 * who_is_right is BOTH (figures agree), ENGINE_PER_RULES (the engine follows
 * the stated rules; the manual figures do not) or UNRESOLVED (the engine
 * could not calculate — see flags).
 *
 * Written for the Apps Script V8 runtime: const/let, template-free ES5
 * function style. No Apps Script services at top level, so the same file is
 * importable under Node.
 */

// ---------------------------------------------------------------------------
// Configuration (period settings — edit here for the next period)
// ---------------------------------------------------------------------------
const PAYROLL_CONFIG = {
  period: { year: 2026, month: 10 },            // month: 1..12
  fx: { USD: 1, EUR: 1.08, RSD: 0.0092 },       // fixed for the period
  withholding: { rate: 0.10, contractType: 'FTE_MONTHLY', country: 'RS' },
  fees: {
    payoneer: { pct: 0.02, cap: 30 },
    wise:     { flat: 5 },
    bank:     { flat: 0 },
  },
  // Contract types whose platform fee is deducted from the payout.
  // FTE_MONTHLY is company-paid (fee shown, not deducted).
  feeDeductedFor: ['HOURLY', 'PER_LESSON'],
  // Activity source and unit expected per contract type (rule 1).
  activitySource: { HOURLY: 'SolidTime', PER_LESSON: 'Dash' },
  activityUnit:   { HOURLY: 'hours',     PER_LESSON: 'lessons' },
  // HOURLY cap: hoursPerDay x working days in the month (rule: an employee
  // cannot be paid for more hours than the month contains). PER_LESSON and
  // FTE_MONTHLY are not capped.
  hoursCap: { hoursPerDay: 8, contractTypes: ['HOURLY'] },
};

// Generic reason templates, keyed by finding code. Kept abstract on purpose:
// they describe the *class* of discrepancy and the rule involved, never the
// concrete amounts of a particular period.
const RECONCILIATION_REASONS = {
  MATCH: 'engine and manual agree on all components',
  NO_MANUAL_ROW: 'no manual row for this employee; engine result stands',
  ENGINE_INCOMPLETE: 'engine inputs are incomplete (see flags); manual figures could not be verified against the source data',
  NOT_REPRODUCIBLE: 'manual figures are not reproducible from rules 1-8; the engine follows the stated rules',
  PRORATION_NOT_APPLIED: 'manual gross reflects an unprorated period; the engine prorates pay when employment covers only part of the period (rule 2)',
  DUPLICATED_UNITS_PAID: 'manual gross includes duplicated activity units; the engine pays each approved import once (rule 1, dedup by import_id)',
  ACTIVITY_OUTSIDE_WINDOW_PAID: 'manual gross includes activity outside the employment window; the engine excludes it (rule 3)',
  ADJUSTMENTS_NOT_APPLIED: 'manual gross does not include the period adjustments; the engine applies them (rule 4)',
  WITHHOLDING_MISMATCH: 'manual withholding differs from the engine calculation (rule 6)',
  FEE_MISMATCH: 'manual platform fee differs from the engine calculation (rule 7)',
};

/** Look up the generic reason template for a finding code. */
function reasonText(code) {
  if (RECONCILIATION_REASONS[code]) {
    return RECONCILIATION_REASONS[code];
  }
  return RECONCILIATION_REASONS.NOT_REPRODUCIBLE;
}

// ---------------------------------------------------------------------------
// Flag catalogue — every flag code with its fixed severity.
// Severity lives ONLY here; makeFlag refuses anything not listed.
// ---------------------------------------------------------------------------
const FLAG_DEFS = {
  // employee record (critical = calculation blocked)
  RATE_INVALID: 'critical',
  CURRENCY_UNKNOWN: 'critical',
  CONTRACT_TYPE_UNKNOWN: 'critical',
  START_DATE_INVALID: 'critical',
  END_DATE_INVALID: 'critical',
  EMPLOYMENT_DATES_INVERTED: 'critical',   // end_date < start_date (equal = 1 day, allowed)
  PAYOUT_METHOD_INVALID: 'critical',       // blank or unrecognised payout method
  MISSING_EMPLOYEE_ID: 'critical',
  DUPLICATE_EMPLOYEE_ID: 'critical',
  // employee record (does not prevent calculation)
  NAME_MISSING: 'info',
  COUNTRY_MISSING: 'info',                 // see reason: country-based rules cannot apply
  DUPLICATE_SLACK_ID: 'warning',           // Part B ticket routing depends on it
  INACTIVE_IN_PERIOD: 'info',              // employment does not overlap the month -> 0, no error
  // activity
  NO_ACTIVITY: 'critical',
  MISSING_UNITS: 'critical',
  NEGATIVE_UNITS: 'critical',
  ACTIVITY_DATE_INVALID: 'critical',       // period_from/period_to missing or malformed
  ACTIVITY_DATES_INVERTED: 'critical',     // period_from > period_to
  DUPLICATE_IMPORT_CONFLICT: 'critical',
  SOURCE_MISMATCH: 'critical',
  DUPLICATE_IMPORT: 'warning',
  HOURS_CAPPED: 'warning',
  ACTIVITY_SPANS_MONTHS: 'warning',        // row not fully inside the payroll month
  ACTIVITY_OUTSIDE_EMPLOYMENT: 'warning',
  ACTIVITY_OUTSIDE_PERIOD: 'warning',
  // adjustments
  ADJUSTMENT_AMOUNT_INVALID: 'critical',
  ADJUSTMENT_CURRENCY_MISSING: 'critical',
  ADJUSTMENT_CURRENCY_UNKNOWN: 'critical',
  ADJUSTMENT_TYPE_UNKNOWN: 'warning',
  ADJUSTMENT_CURRENCY_MISMATCH: 'warning',
  // manual payroll
  MANUAL_VALUE_INVALID: 'critical',        // non-numeric or negative column value
  MISSING_MANUAL_ROW: 'critical',
  DUPLICATE_MANUAL_ROW: 'warning',
  // cross-tab (no employee row in payout_oct -> global flag list)
  ORPHAN_ACTIVITY: 'critical',
  ORPHAN_ADJUSTMENT: 'critical',
  ORPHAN_MANUAL_ROW: 'critical',
  MANUAL_ROW_NO_ID: 'critical',
  FTE_ACTIVITY_PRESENT: 'warning',
  // reconciliation escalation (manual vs engine money/components)
  RECON_MONEY_MISMATCH: 'critical',
  RECON_COMPONENT_MISMATCH: 'warning',
};

function makeFlag(code, target, reason) {
  const severity = FLAG_DEFS[code];
  if (!severity) {
    throw new Error('Unknown flag code: ' + code);
  }
  return { code: code, severity: severity, target: target, reason: reason };
}

// ---------------------------------------------------------------------------
// Calendar helpers (rule 2) — working days are computed, never hardcoded
// ---------------------------------------------------------------------------

/** True when the UTC date is Monday..Friday. */
function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/** Number of Mon-Fri days in a month. month: 1..12. */
function workingDaysInMonth(year, month) {
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= totalDays; d++) {
    if (isWeekday(new Date(Date.UTC(year, month - 1, d)))) {
      count++;
    }
  }
  return count;
}

/**
 * Mon-Fri days inside [max(start_date, month start), min(end_date, month end)].
 * startISO/endISO are 'YYYY-MM-DD' strings; either may be null/blank (unbounded).
 * start_date == end_date inside the month counts as 1 working day.
 */
function workedDaysClipped(startISO, endISO, year, month) {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 0);
  let from = monthStart;
  let to = monthEnd;
  const startDate = parseISODate(startISO);
  const endDate = parseISODate(endISO);
  if (startDate && startDate.getTime() > from) {
    from = startDate.getTime();
  }
  if (endDate && endDate.getTime() < to) {
    to = endDate.getTime();
  }
  if (to < from) {
    return 0;
  }
  let count = 0;
  for (let t = from; t <= to; t += 24 * 3600 * 1000) {
    if (isWeekday(new Date(t))) {
      count++;
    }
  }
  return count;
}

/** 'YYYY-MM-DD' -> Date (UTC) or null when blank/unparseable. */
function parseISODate(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) {
    return null;
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Round to 2 decimals, half away from zero (symmetric for negative payouts).
 * The 1e-9 nudge absorbs binary representation noise so intended halves
 * (1.005 -> 100.4999...) still round up; it is far below cent granularity.
 */
function round2(value) {
  if (value === null || value === undefined || isNaN(value)) {
    return null;
  }
  const scaled = Math.abs(value * 100) + 1e-9;
  const rounded = Math.round(scaled);
  return value < 0 ? -rounded / 100 : rounded / 100;
}

/**
 * Parse a number from input. Locale/thousands formatting is expected to be
 * normalised upstream (Google Sheets / n8n deliver raw values); only plain
 * numbers and simple decimal-comma strings are handled here.
 */
function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const parsed = Number(text.replace(',', '.'));
  return isNaN(parsed) ? null : parsed;
}

/** Merge flags, dropping exact duplicates by code+target. */
function mergeFlags(flags, extra) {
  const seen = {};
  const all = (flags || []).concat(extra || []);
  const result = [];
  for (let i = 0; i < all.length; i++) {
    const key = all[i].code + '|' + (all[i].target || '');
    if (!seen[key]) {
      seen[key] = true;
      result.push(all[i]);
    }
  }
  return result;
}

function flagsToText(flags) {
  return mergeFlags([], flags).map(function (f) {
    return f.code + ': ' + f.reason;
  }).join('; ');
}

function hasCriticalFlag(flags) {
  return (flags || []).some(function (f) {
    return f.severity === 'critical';
  });
}

/** Row status from flag severities: CRITICAL > WARNING > OK (info ignored). */
function maxSeverityStatus(flags) {
  let worst = 'OK';
  (flags || []).forEach(function (f) {
    if (f.severity === 'critical') {
      worst = 'CRITICAL';
    } else if (f.severity === 'warning' && worst !== 'CRITICAL') {
      worst = 'WARNING';
    }
  });
  return worst;
}

// ---------------------------------------------------------------------------
// Source validation — employees tab (record level)
// ---------------------------------------------------------------------------

/**
 * Validate one employee record and compute the payable window:
 * employment dates intersected with the payroll period (rules 2 and 3).
 * Critical flags here block the employee's calculation.
 * Returns { flags, inactive, windowFrom, windowTo, periodStart, periodEnd }.
 */
function validateEmployeeRecord(emp, config) {
  const flags = [];
  const target = emp.employee_id || 'unknown';
  let inactive = false;

  // required columns — anything that makes the calculation unreliable
  const rate = toNumber(emp.rate);
  if (rate === null || rate <= 0) {
    flags.push(makeFlag('RATE_INVALID', target,
      'rate is missing, non-numeric or <= 0'));
  }

  const currency = emp.contract_currency;
  if (!currency || !config.fx[currency]) {
    flags.push(makeFlag('CURRENCY_UNKNOWN', target,
      'contract_currency "' + currency + '" is missing or has no FX rate configured'));
  }

  const contractKnown = emp.contract_type === 'FTE_MONTHLY' ||
                        !!config.activitySource[emp.contract_type];
  if (!contractKnown) {
    flags.push(makeFlag('CONTRACT_TYPE_UNKNOWN', target,
      'contract_type "' + emp.contract_type + '" is not FTE_MONTHLY/HOURLY/PER_LESSON'));
  }

  const method = normalizePayoutMethod(emp.payout_method);
  if (!method) {
    flags.push(makeFlag('PAYOUT_METHOD_INVALID', target,
      'payout_method "' + emp.payout_method + '" is missing; the platform fee cannot be computed'));
  } else if (!config.fees[method]) {
    flags.push(makeFlag('PAYOUT_METHOD_INVALID', target,
      'payout_method "' + emp.payout_method + '" is not recognised (expected payoneer/wise/bank); the platform fee cannot be computed'));
  }

  // dates: start is required, end is optional; both must parse when present
  let startDate = null;
  if (isBlank(emp.start_date)) {
    flags.push(makeFlag('START_DATE_INVALID', target, 'start_date is missing'));
  } else {
    startDate = parseISODate(emp.start_date);
    if (!startDate) {
      flags.push(makeFlag('START_DATE_INVALID', target,
        'start_date "' + emp.start_date + '" is not a valid YYYY-MM-DD date'));
    }
  }
  let endDate = null;
  if (!isBlank(emp.end_date)) {
    endDate = parseISODate(emp.end_date);
    if (!endDate) {
      flags.push(makeFlag('END_DATE_INVALID', target,
        'end_date "' + emp.end_date + '" is not a valid YYYY-MM-DD date'));
    }
  }
  // end < start is an error; start == end is allowed (1 working day)
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    flags.push(makeFlag('EMPLOYMENT_DATES_INVERTED', target,
      'end_date ' + emp.end_date + ' is before start_date ' + emp.start_date));
  }

  // columns that do not prevent calculation — informational only
  if (isBlank(emp.name)) {
    flags.push(makeFlag('NAME_MISSING', target, 'name is empty (informational; does not affect the calculation)'));
  }
  if (isBlank(emp.country)) {
    flags.push(makeFlag('COUNTRY_MISSING', target,
      'country is empty (informational; country-based rules such as RS withholding cannot apply)'));
  }

  // payable window = employment ∩ payroll period
  const periodStart = Date.UTC(config.period.year, config.period.month - 1, 1);
  const periodEnd = Date.UTC(config.period.year, config.period.month, 0);
  const windowFrom = (startDate && startDate.getTime() > periodStart) ? startDate.getTime() : periodStart;
  const windowTo = (endDate && endDate.getTime() < periodEnd) ? endDate.getTime() : periodEnd;
  if (windowTo < windowFrom) {
    // not employed in this period: calculated as 0 — not an error
    flags.push(makeFlag('INACTIVE_IN_PERIOD', target,
      'employment window does not overlap the payroll period; calculated as 0'));
    inactive = true;
  }

  return {
    flags: flags,
    inactive: inactive,
    windowFrom: windowFrom,
    windowTo: windowTo,
    periodStart: periodStart,
    periodEnd: periodEnd,
  };
}

/** trim + lowercase for payout method comparison; '' when blank. */
function normalizePayoutMethod(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Source validation — activity rows of one employee (rules 1 and 3)
// ---------------------------------------------------------------------------

/**
 * Inspect the raw activity rows of one employee and select the payable units.
 * Duplicate import_ids: identical -> deduplicated (paid once, flagged);
 * conflicting -> blocked (critical). Rows from a wrong source or entirely
 * outside the payable window (employment ∩ period) are excluded. Blank or
 * negative units block the calculation. HOURLY totals above the monthly
 * working-hours cap are capped (flagged).
 * Returns { paidUnits, paidUnitsKnown, blocked, excludedUnits,
 *           duplicateUnits, capped, loggedUnits, cap, flags }.
 */
function selectPayableActivity(activity, emp, validation, config) {
  const flags = [];
  const target = emp.employee_id || 'unknown';
  const expectedSource = config.activitySource[emp.contract_type];
  const expectedUnit = config.activityUnit[emp.contract_type];

  const result = {
    paidUnits: 0,        // sum of units that will be paid
    paidUnitsKnown: true,// false when any needed row has blank/non-numeric units
    blocked: false,      // true when a duplicate conflict blocks the calculation
    excludedUnits: 0,    // units excluded by the employment/period window
    duplicateUnits: 0,   // units carried by duplicate import rows
    capped: false,       // true when the HOURLY cap was applied
    loggedUnits: 0,      // approved units before the cap
    cap: null,           // the cap value, when configured
    flags: flags,
  };

  if (!expectedSource) {
    // Not an activity-based contract; nothing to select.
    return result;
  }

  if (!activity || activity.length === 0) {
    flags.push(makeFlag('NO_ACTIVITY', target,
      'contract type ' + emp.contract_type + ' requires ' + expectedSource +
      ' activity but none was imported; not calculated'));
    result.paidUnitsKnown = false;
    return result;
  }

  const groups = groupActivityByImportId(activity);
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];

    // duplicate import rows: identical -> pay once; conflicting -> block
    if (group.length > 1) {
      if (activityRowsAllEqual(group)) {
        const extraUnits = toNumber(group[0].units);
        if (extraUnits !== null) {
          result.duplicateUnits += extraUnits * (group.length - 1);
        }
        flags.push(makeFlag('DUPLICATE_IMPORT',
          target + '/' + group[0].import_id,
          'import_id ' + group[0].import_id + ' appears ' + group.length +
          ' times with identical data; paid once, duplicates ignored'));
      } else {
        flags.push(makeFlag('DUPLICATE_IMPORT_CONFLICT',
          target + '/' + group[0].import_id,
          'import_id ' + group[0].import_id + ' appears ' + group.length +
          ' times with conflicting data; calculation blocked until the import is corrected'));
        result.blocked = true;
        continue;
      }
    }

    const act = group[0];
    const actTarget = target + '/' + (act.import_id || 'untitled');

    // source/unit consistency (rule 1: SolidTime hours / Dash lessons)
    if (act.source !== expectedSource) {
      flags.push(makeFlag('SOURCE_MISMATCH', actTarget,
        'mismatched employment type in activity record: source "' + act.source +
        '", but expected: ' + expectedSource + ' for ' + emp.contract_type +
        '; calculation blocked until the activity data is corrected'));
      continue;
    }

    // period dates must be present, valid and ordered; otherwise the row
    // cannot be windowed reliably and the calculation is blocked
    if (isBlank(act.period_from) || isBlank(act.period_to)) {
      flags.push(makeFlag('ACTIVITY_DATE_INVALID', actTarget,
        'period_from/period_to are missing in import ' + (act.import_id || '(no id)') +
        '; the row cannot be windowed'));
      result.blocked = true;
      continue;
    }
    const rowFrom = parseISODate(act.period_from);
    const rowTo = parseISODate(act.period_to);
    if (!rowFrom || !rowTo) {
      flags.push(makeFlag('ACTIVITY_DATE_INVALID', actTarget,
        'period dates in import ' + (act.import_id || '(no id)') +
        ' are not valid YYYY-MM-DD dates ("' + act.period_from + '".."' + act.period_to + '")'));
      result.blocked = true;
      continue;
    }
    if (rowFrom.getTime() > rowTo.getTime()) {
      flags.push(makeFlag('ACTIVITY_DATES_INVERTED', actTarget,
        'period_from ' + act.period_from + ' is after period_to ' + act.period_to +
        ' in import ' + (act.import_id || '(no id)')));
      result.blocked = true;
      continue;
    }

    // payable window (rules 2 and 3): rows entirely outside
    // [employment ∩ payroll period] are not paid
    const outsideEmployment = (rowFrom.getTime() > validation.windowTo) ||
                              (rowTo.getTime() < validation.windowFrom);
    if (outsideEmployment) {
      const outUnits = toNumber(act.units);
      if (outUnits !== null) {
        result.excludedUnits += outUnits;
      }
      const outsidePeriodOnly = (rowFrom && rowFrom.getTime() > validation.periodEnd) ||
                                (rowTo && rowTo.getTime() < validation.periodStart);
      flags.push(makeFlag(
        outsidePeriodOnly ? 'ACTIVITY_OUTSIDE_PERIOD' : 'ACTIVITY_OUTSIDE_EMPLOYMENT',
        actTarget,
        (outUnits === null ? 'unknown units' : outUnits + ' ' + (act.unit || expectedUnit)) +
        ' logged in ' + (act.period_from || '?') + '..' + (act.period_to || '?') +
        (outsidePeriodOnly
          ? ' outside the payroll period'
          : ' outside employment window ' + (emp.start_date || '...') + '..' + (emp.end_date || '...')) +
        '; not paid per employment-dates rule'));
      continue;
    }

    // rows must sit within the payroll month: boundary-spanning rows are
    // paid in full (units cannot be split by day) but flagged for review
    if (rowFrom.getTime() < validation.periodStart || rowTo.getTime() > validation.periodEnd) {
      flags.push(makeFlag('ACTIVITY_SPANS_MONTHS', actTarget,
        'activity period ' + act.period_from + '..' + act.period_to +
        ' is not within the payroll period; full units counted, review advised'));
    }

    // partially overlapping rows are paid in full (deterministic rule
    // application; a manual disagreement is caught by reconciliation)

    const units = toNumber(act.units);
    if (units === null) {
      result.paidUnitsKnown = false;
      flags.push(makeFlag('MISSING_UNITS', actTarget,
        'approved ' + (act.unit || expectedUnit) + ' are blank/non-numeric in ' +
        act.source + ' import ' + (act.import_id || '(no id)') +
        '; base pay cannot be computed'));
      continue;
    }
    if (units < 0) {
      flags.push(makeFlag('NEGATIVE_UNITS', actTarget,
        'negative units (' + units + ') in import ' + act.import_id));
      continue;
    }
    result.paidUnits += units;
  }

  // HOURLY cap: hoursPerDay x working days in the month
  const capConfig = config.hoursCap;
  if (capConfig && capConfig.contractTypes.indexOf(emp.contract_type) >= 0) {
    const cap = capConfig.hoursPerDay * workingDaysInMonth(config.period.year, config.period.month);
    result.cap = cap;
    if (result.paidUnits > cap) {
      flags.push(makeFlag('HOURS_CAPPED', target,
        result.paidUnits + ' approved hours exceed ' + cap + ' working hours in the month (' +
        capConfig.hoursPerDay + 'h x ' + (cap / capConfig.hoursPerDay) +
        ' working days); capped to ' + cap));
      result.loggedUnits = result.paidUnits;
      result.paidUnits = cap;
      result.capped = true;
    }
  }

  return result;
}

/** Group activity rows by import_id, preserving first-seen order. */
function groupActivityByImportId(activity) {
  const groups = [];
  const byImportId = {};
  let untitled = 0;
  for (let i = 0; i < activity.length; i++) {
    const row = activity[i];
    const key = row.import_id || ('__untitled_' + (untitled++));
    if (!byImportId[key]) {
      byImportId[key] = [];
      groups.push(byImportId[key]);
    }
    byImportId[key].push(row);
  }
  return groups;
}

/**
 * True when every field of every row matches (row_number and other sheet
 * metadata ignored). Values that parse as numbers on both sides are compared
 * numerically, so formatting-only differences (120 vs "120" vs "120,00")
 * do not count as conflicts — only real data differences do.
 */
function activityRowsAllEqual(group) {
  const reference = group[0];
  for (let i = 1; i < group.length; i++) {
    const keys = {};
    for (const a in reference) {
      if (a !== 'row_number') {
        keys[a] = true;
      }
    }
    for (const a in group[i]) {
      if (a !== 'row_number') {
        keys[a] = true;
      }
    }
    for (const key in keys) {
      if (!fieldValuesEqual(reference[key], group[i][key])) {
        return false;
      }
    }
  }
  return true;
}

/** Numeric when both sides are numeric, string comparison otherwise. */
function fieldValuesEqual(left, right) {
  const leftText = left === null || left === undefined ? '' : String(left);
  const rightText = right === null || right === undefined ? '' : String(right);
  const leftNumber = toNumber(leftText);
  const rightNumber = toNumber(rightText);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber === rightNumber;
  }
  return leftText === rightText;
}

// ---------------------------------------------------------------------------
// Source validation — adjustments of one employee (rule 4)
// ---------------------------------------------------------------------------

/**
 * Validate and total the adjustments of one employee. Amount and currency are
 * required (critical when missing/invalid). Amounts in the contract currency
 * are added directly; other known currencies are converted via the period FX
 * rates and flagged.
 * Returns { total, flags }.
 */
function applyAdjustments(adjustments, emp, config) {
  const flags = [];
  const target = emp.employee_id || 'unknown';
  let total = 0;
  const items = adjustments || [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const amount = toNumber(item.amount);
    const label = item.comment || item.type || ('adjustment ' + (i + 1));

    if (amount === null) {
      flags.push(makeFlag('ADJUSTMENT_AMOUNT_INVALID', target,
        'adjustment "' + label + '" has no valid amount'));
      continue;
    }

    if (isBlank(item.currency)) {
      flags.push(makeFlag('ADJUSTMENT_CURRENCY_MISSING', target,
        'adjustment "' + label + '" has no currency; cannot be applied reliably'));
      continue;
    }

    if (item.type !== 'bonus' && item.type !== 'advance_deduction') {
      flags.push(makeFlag('ADJUSTMENT_TYPE_UNKNOWN', target,
        'adjustment type "' + item.type + '" is not bonus/advance_deduction; amount still applied'));
    }

    const currency = String(item.currency).trim();
    if (currency === emp.contract_currency) {
      total += amount;
      continue;
    }

    if (config.fx[currency] && config.fx[emp.contract_currency]) {
      // convert to contract currency via period FX rates, and flag it
      total += amount * config.fx[currency] / config.fx[emp.contract_currency];
      flags.push(makeFlag('ADJUSTMENT_CURRENCY_MISMATCH', target,
        'adjustment "' + label + '" is in ' + currency +
        ' while the contract is in ' + emp.contract_currency +
        '; converted using period FX, review advised'));
      continue;
    }

    flags.push(makeFlag('ADJUSTMENT_CURRENCY_UNKNOWN', target,
      'adjustment currency "' + currency + '" has no FX rate configured'));
  }

  return { total: total, flags: flags };
}

// ---------------------------------------------------------------------------
// Source validation — manual payroll tab
// ---------------------------------------------------------------------------

/** True when all four money columns parse as numbers >= 0. */
function manualRowIsValid(row) {
  const cols = ['gross_usd', 'withholding_usd', 'fee_deducted_usd', 'net_usd'];
  for (let i = 0; i < cols.length; i++) {
    const value = toNumber(row[cols[i]]);
    if (value === null || value < 0) {
      return false;
    }
  }
  return true;
}

/** First invalid column of a manual row, for the flag reason. */
function firstInvalidManualColumn(row) {
  const cols = ['gross_usd', 'withholding_usd', 'fee_deducted_usd', 'net_usd'];
  for (let i = 0; i < cols.length; i++) {
    const value = toNumber(row[cols[i]]);
    if (value === null) {
      return cols[i] + ' is non-numeric ("' + row[cols[i]] + '")';
    }
    if (value < 0) {
      return cols[i] + ' is negative (' + value + ')';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Payroll calculation (rules 1-8)
// ---------------------------------------------------------------------------

/**
 * Process one employee into a payroll row.
 * input: {
 *   employee:        { employee_id, slack_user_id, name, contract_type, country,
 *                      contract_currency, rate, payout_method, start_date, end_date },
 *   flags:           [ flag ]        // source-validation flags (pre-computed)
 *   inactive:        bool,           // employment does not overlap the period
 *   window:          { windowFrom, windowTo, periodStart, periodEnd },
 *   selection:       selectPayableActivity() result,
 *   adjustmentResult:applyAdjustments() result,
 *   manualRows:      [ manual row ]  // ALL manual rows routed to this employee
 * }
 */
function buildPayrollRow(input, config) {
  const cfg = config || PAYROLL_CONFIG;
  const emp = input.employee || {};
  let flags = mergeFlags([], input.flags || []);
  const manualRows = input.manualRows || [];
  const validManual = manualRows.filter(manualRowIsValid);
  const row = newEmptyRow(emp, validManual[0] || null);
  const sourceBlocked = hasCriticalFlag(flags);
  let gross = null;

  if (!sourceBlocked) {
    // --- base pay (rule 1 + rule 2) ----------------------------------------
    const monthWorkingDays = workingDaysInMonth(cfg.period.year, cfg.period.month);
    const selection = input.selection;
    const adjustmentResult = input.adjustmentResult;
    const rate = toNumber(emp.rate);
    const fx = cfg.fx[emp.contract_currency];
    let workedDays = null;

    if (emp.contract_type === 'FTE_MONTHLY') {
      workedDays = workedDaysClipped(emp.start_date, emp.end_date, cfg.period.year, cfg.period.month);
      row.worked_days = workedDays;
      row.month_working_days = monthWorkingDays;
      row.base_pay_ccy = rate * workedDays / monthWorkingDays;
    } else {
      row.base_pay_ccy = rate * selection.paidUnits;
    }

    // --- adjustments (rule 4) ------------------------------------------------
    row.adjustments_ccy = round2(adjustmentResult.total);

    // --- gross USD (rule 5), withholding (rule 6), fee (rule 7), net (rule 8) -
    const totalCcy = row.base_pay_ccy + adjustmentResult.total;
    row.total_ccy = round2(totalCcy);
    row.fx_rate = fx;
    gross = totalCcy * fx;
    row.gross_usd = round2(gross);

    const withholding = calcWithholding(emp, gross, cfg);
    row.withholding_usd = round2(withholding);

    const fee = calcFee(emp, gross, cfg);
    flags = flags.concat(fee.flags);
    row.fee_charged_usd = round2(fee.charged);
    row.fee_deducted_usd = round2(fee.deducted);

    // net (rule 8): round only now
    row.net_usd = round2(gross - withholding - fee.deducted);

    // --- calculation trace (always in payout_oct; in mismatch reasons too) ---
    row.calculation = buildCalculationTrace(emp, {
      rate: rate,
      workedDays: workedDays,
      monthWorkingDays: monthWorkingDays,
      paidUnits: selection.paidUnits,
      unit: cfg.activityUnit[emp.contract_type],
      capped: selection.capped,
      loggedUnits: selection.loggedUnits,
      cap: selection.cap,
      inactive: !!input.inactive,
      adjustmentTotal: adjustmentResult.total,
      totalCcy: totalCcy,
      fx: fx,
      gross: row.gross_usd,
      withholding: row.withholding_usd,
      feeCharged: row.fee_charged_usd,
      feeDeducted: row.fee_deducted_usd,
      net: row.net_usd,
    });
  }

  // --- reconciliation vs manual payroll ------------------------------------
  let reconciliation;
  if (sourceBlocked) {
    // source data is broken: no engine figures, nothing to compare
    reconciliation = {
      matches: null, code: 'ENGINE_INCOMPLETE', whoIsRight: 'UNRESOLVED',
      reason: reasonText('ENGINE_INCOMPLETE'),
      moneyMismatch: false, componentMismatch: false,
    };
  } else {
    // invalid manual rows are flagged here (critical for the row status) but
    // never block the engine calculation — they are only excluded below
    manualRows.forEach(function (m, i) {
      if (!manualRowIsValid(m)) {
        flags.push(makeFlag('MANUAL_VALUE_INVALID', row.employee_id || 'unknown',
          'manual payroll row ' + (i + 1) + ' for this employee is invalid: ' +
          firstInvalidManualColumn(m) + '; row excluded from comparison'));
      }
    });

    // compare EVERY valid manual row (gross AND net); first disagreeing row wins
    let mismatchRow = null;
    for (let i = 0; i < validManual.length; i++) {
      if (!manualRowMatchesEngine(validManual[i], row)) {
        mismatchRow = validManual[i];
        break;
      }
    }
    const comparisonRow = mismatchRow || validManual[0] || null;

    if (!input.inactive && manualRows.length === 0) {
      flags.push(makeFlag('MISSING_MANUAL_ROW', row.employee_id || 'unknown',
        'missing employee payroll calculation'));
    }

    reconciliation = reconcile(row, comparisonRow, {
      employee: emp,
      config: cfg,
      gross: gross,
      selection: input.selection,
      adjustmentTotal: input.adjustmentResult.total,
      monthWorkingDays: row.month_working_days,
      unpayable: false,
    });

    // escalation flags: money difference -> critical; component-only -> warning
    // (the calculation trace lives in the row's own `calculation` column)
    if (reconciliation.moneyMismatch) {
      flags.push(makeFlag('RECON_MONEY_MISMATCH', row.employee_id || 'unknown',
        moneyMismatchReason(row, comparisonRow)));
    }
    if (reconciliation.componentMismatch) {
      flags.push(makeFlag('RECON_COMPONENT_MISMATCH', row.employee_id || 'unknown',
        componentMismatchReason(reconciliation)));
    }
    if (manualRows.length > 1) {
      flags.push(makeFlag('DUPLICATE_MANUAL_ROW', row.employee_id || 'unknown',
        'multiple payroll calculations for the same employee' +
        (mismatchRow ? '; at least one differs from the engine' : '; all agree with the engine')));
    }
  }
  row.matches_manual = reconciliation.matches;
  row.who_is_right = reconciliation.whoIsRight;
  row.reconciliation_reason = reconciliation.reason;
  row.reconciliation_code = reconciliation.code; // machine-readable; dropped before writing to the sheet

  // --- finalise --------------------------------------------------------------
  if (row.net_usd !== null && row.manual_net_usd !== null) {
    row.net_delta_usd = round2(row.net_usd - row.manual_net_usd);
  }
  row.flags = flagsToText(flags);
  row.status = maxSeverityStatus(flags);
  return row;
}

/** Skeleton of the output row; manual figures default to 0 when absent. */
function newEmptyRow(emp, manual) {
  return {
    slack_user_id: emp.slack_user_id || null,
    employee_id: emp.employee_id || null,
    name: emp.name || null,
    contract_type: emp.contract_type || null,
    country: emp.country || null,
    payout_method: emp.payout_method || null,
    contract_currency: emp.contract_currency || null,
    rate: toNumber(emp.rate),
    base_pay_ccy: null,
    adjustments_ccy: null,
    total_ccy: null,
    fx_rate: null,
    gross_usd: null,
    withholding_usd: null,
    fee_charged_usd: null,
    fee_deducted_usd: null,
    net_usd: null,
    calculation: null,
    manual_gross_usd: manual ? toNumber(manual.gross_usd) : 0,
    manual_net_usd: manual ? toNumber(manual.net_usd) : 0,
    net_delta_usd: null,
    matches_manual: null,
    who_is_right: null,
    reconciliation_reason: null,
    worked_days: null,
    month_working_days: null,
    flags: null,
    status: 'OK',
  };
}

/** Withholding (rule 6): 10% of gross for FTE_MONTHLY in RS, nobody else. */
function calcWithholding(emp, gross, config) {
  if (emp.contract_type === config.withholding.contractType &&
      emp.country === config.withholding.country) {
    return gross * config.withholding.rate;
  }
  return 0;
}

/**
 * Platform fee (rule 7). Returns { charged, deducted, flags }: `charged` is
 * what the platform bills, `deducted` is what is taken out of the payout
 * (zero for FTE_MONTHLY — the company pays the fee).
 */
function calcFee(emp, gross, config) {
  const method = normalizePayoutMethod(emp.payout_method);
  let charged = 0;

  if (method === 'payoneer') {
    charged = Math.min(gross * config.fees.payoneer.pct, config.fees.payoneer.cap);
  } else if (method === 'wise') {
    charged = config.fees.wise.flat;
  } else if (method === 'bank') {
    charged = config.fees.bank.flat;
  } else {
    return {
      charged: 0,
      deducted: 0,
      flags: [makeFlag('PAYOUT_METHOD_INVALID', emp.employee_id,
        'payout_method "' + emp.payout_method + '" is not recognised; calculation should have been blocked')],
    };
  }

  let deducted = 0;
  if (config.feeDeductedFor.indexOf(emp.contract_type) >= 0) {
    deducted = charged;
  }
  return { charged: charged, deducted: deducted, flags: [] };
}

/** Human-readable derivation of the row's figures (shown in payout_oct). */
function buildCalculationTrace(emp, c) {
  const ccy = emp.contract_currency;
  const parts = [];
  if (c.inactive) {
    return 'employment does not overlap the payroll period; calculated 0';
  }
  if (emp.contract_type === 'FTE_MONTHLY') {
    parts.push(c.rate + ' ' + ccy + ' (salary) x ' + c.workedDays + '/' + c.monthWorkingDays + ' working days');
  } else {
    const unitsText = c.paidUnits + ' ' + (c.unit || 'units') +
      (c.capped ? ' (capped from ' + c.loggedUnits + ' logged, max ' + c.cap + ')' : '');
    parts.push(c.rate + ' ' + ccy + ' (rate) x ' + unitsText);
  }
  if (c.adjustmentTotal !== 0) {
    parts.push((c.adjustmentTotal > 0 ? '+ ' : '- ') +
      Math.abs(c.adjustmentTotal).toFixed(2) + ' ' + ccy + ' (adjustments)');
  }
  parts.push('= ' + c.totalCcy.toFixed(2) + ' ' + ccy);
  if (c.fx !== 1) {
    parts.push('x ' + c.fx + ' (FX to USD)');
  }
  parts.push('= ' + c.gross.toFixed(2) + ' USD gross');
  if (c.withholding > 0) {
    parts.push('- ' + c.withholding.toFixed(2) + ' USD (withholding)');
  }
  if (c.feeCharged > 0) {
    parts.push('- ' + c.feeDeducted.toFixed(2) + ' USD (' + emp.payout_method + ' fee' +
      (c.feeDeducted === 0 ? ', company-paid' : '') + ')');
  }
  parts.push('= ' + c.net.toFixed(2) + ' USD net');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Reconciliation vs the manual payroll
// ---------------------------------------------------------------------------

/** gross AND net of a manual row agree with the engine (tolerance $0.005). */
function manualRowMatchesEngine(manual, row) {
  const manualGross = toNumber(manual.gross_usd);
  const manualNet = toNumber(manual.net_usd);
  const grossOk = manualGross !== null && row.gross_usd !== null &&
                  Math.abs(row.gross_usd - manualGross) < 0.005;
  const netOk = manualNet !== null && row.net_usd !== null &&
                Math.abs(row.net_usd - manualNet) < 0.005;
  return grossOk && netOk;
}

/**
 * Compare the engine row against HR's manual row. Mismatches are classified
 * into generic finding codes; the human-readable reason is assembled from the
 * RECONCILIATION_REASONS templates, never hand-written per case.
 * Returns { matches, code, whoIsRight, reason, moneyMismatch, componentMismatch,
 *           withholdingDiff, feeDiff }:
 *   - moneyMismatch: gross or net differs (over-/underpayment) -> critical flag
 *   - componentMismatch: gross AND net agree but withholding/fee differ
 *     -> warning flag; both put the row into review.
 */
function reconcile(row, manual, ctx) {
  if (!manual) {
    return {
      matches: null,
      code: 'NO_MANUAL_ROW',
      whoIsRight: 'ENGINE_PER_RULES',
      reason: reasonText('NO_MANUAL_ROW'),
      moneyMismatch: false,
      componentMismatch: false,
    };
  }

  if (ctx.unpayable || ctx.gross === null) {
    return {
      matches: false,
      code: 'ENGINE_INCOMPLETE',
      whoIsRight: 'UNRESOLVED',
      reason: reasonText('ENGINE_INCOMPLETE'),
      moneyMismatch: false,
      componentMismatch: false,
    };
  }

  const manualGross = toNumber(manual.gross_usd);
  const manualNet = toNumber(manual.net_usd);
  const manualWithholding = toNumber(manual.withholding_usd);
  const manualFee = toNumber(manual.fee_deducted_usd);

  // net per rule 8: rounded ONCE at the end from full-precision components.
  // Never recompute it from the rounded display columns — the rounded
  // withholding/fee can shift the result by a cent (e.g. E02: true net
  // 1484.51 vs 1649.45 - 164.95 = 1484.50).
  const engineNet = row.net_usd;
  const netMatches = manualNet !== null && Math.abs(engineNet - manualNet) < 0.005;
  const grossMatches = manualGross !== null && Math.abs(row.gross_usd - manualGross) < 0.005;

  // component comparison (rules 6-7): manual withholding / deducted fee
  // vs engine; positive diff = manual higher than the engine
  const withholdingDiff = (manualWithholding !== null && row.withholding_usd !== null)
    ? round2(manualWithholding - row.withholding_usd) : null;
  const feeDiff = (manualFee !== null && row.fee_deducted_usd !== null)
    ? round2(manualFee - row.fee_deducted_usd) : null;
  const componentDiffers = (withholdingDiff !== null && Math.abs(withholdingDiff) >= 0.005) ||
                           (feeDiff !== null && Math.abs(feeDiff) >= 0.005);
  const componentMismatch = netMatches && grossMatches && componentDiffers;

  if (netMatches && grossMatches) {
    if (componentMismatch) {
      // gross and net agree, but the components producing the net differ:
      // compensating manual errors — warning-level, still needs review.
      const parts = [];
      if (withholdingDiff !== null && Math.abs(withholdingDiff) >= 0.005) {
        parts.push(reasonText('WITHHOLDING_MISMATCH'));
      }
      if (feeDiff !== null && Math.abs(feeDiff) >= 0.005) {
        parts.push(reasonText('FEE_MISMATCH'));
      }
      return {
        matches: false,
        code: 'COMPONENT_MISMATCH',
        whoIsRight: 'ENGINE_PER_RULES',
        reason: parts.join('; '),
        moneyMismatch: false,
        componentMismatch: true,
        withholdingDiff: withholdingDiff,
        feeDiff: feeDiff,
      };
    }
    return {
      matches: true,
      code: 'MATCH',
      whoIsRight: 'BOTH',
      reason: reasonText('MATCH'),
      moneyMismatch: false,
      componentMismatch: false,
    };
  }

  // Classify the mismatch into generic finding codes. Component findings
  // (withholding, fee) only fire when the grosses already agree: when the
  // gross itself differs, component differences are its consequence, not
  // independent errors.
  const findings = [];
  if (findsProrationNotApplied(row, ctx, manualGross)) {
    findings.push('PRORATION_NOT_APPLIED');
  }
  if (findsDuplicatedUnitsPaid(row, ctx, manualGross)) {
    findings.push('DUPLICATED_UNITS_PAID');
  }
  if (findsActivityOutsideWindowPaid(row, ctx, manualGross)) {
    findings.push('ACTIVITY_OUTSIDE_WINDOW_PAID');
  }
  if (findsAdjustmentsNotApplied(row, ctx, manualGross)) {
    findings.push('ADJUSTMENTS_NOT_APPLIED');
  }
  if (grossMatches && manualWithholding !== null && row.withholding_usd !== null &&
      Math.abs(manualWithholding - row.withholding_usd) >= 0.005) {
    findings.push('WITHHOLDING_MISMATCH');
  }
  if (grossMatches && manualFee !== null && row.fee_deducted_usd !== null &&
      Math.abs(manualFee - row.fee_deducted_usd) >= 0.005) {
    findings.push('FEE_MISMATCH');
  }
  if (findings.length === 0) {
    findings.push('NOT_REPRODUCIBLE');
  }

  const moneyMismatch = (manualGross !== null && Math.abs(row.gross_usd - manualGross) >= 0.005) ||
                        (manualNet !== null && Math.abs(engineNet - manualNet) >= 0.005);

  return {
    matches: false,
    code: 'MISMATCH',
    whoIsRight: 'ENGINE_PER_RULES',
    reason: findings.map(reasonText).join('; '),
    moneyMismatch: moneyMismatch,
    componentMismatch: false,
  };
}

/** manual gross equals the unprorated salary in USD while the engine prorates. */
function findsProrationNotApplied(row, ctx, manualGross) {
  if (ctx.employee.contract_type !== 'FTE_MONTHLY') {
    return false;
  }
  if (row.worked_days === null || row.worked_days >= ctx.monthWorkingDays) {
    return false;
  }
  const fullMonthGross = row.rate * ctx.config.fx[ctx.employee.contract_currency];
  return manualGross !== null && Math.abs(manualGross - fullMonthGross) < 0.005;
}

/** manual gross equals ours plus the duplicated units. */
function findsDuplicatedUnitsPaid(row, ctx, manualGross) {
  if (ctx.selection.duplicateUnits <= 0) {
    return false;
  }
  const fx = ctx.config.fx[ctx.employee.contract_currency];
  const withDuplicates = ctx.gross + ctx.selection.duplicateUnits * row.rate * fx;
  return manualGross !== null && Math.abs(manualGross - withDuplicates) < 0.005;
}

/** manual gross equals ours plus the units excluded by the employment window. */
function findsActivityOutsideWindowPaid(row, ctx, manualGross) {
  if (ctx.selection.excludedUnits <= 0) {
    return false;
  }
  const fx = ctx.config.fx[ctx.employee.contract_currency];
  const withExcluded = ctx.gross + ctx.selection.excludedUnits * row.rate * fx;
  return manualGross !== null && Math.abs(manualGross - withExcluded) < 0.005;
}

/** manual gross equals base pay only, ignoring the period adjustments. */
function findsAdjustmentsNotApplied(row, ctx, manualGross) {
  if (ctx.adjustmentTotal === 0) {
    return false;
  }
  const fx = ctx.config.fx[ctx.employee.contract_currency];
  const withoutAdjustments = row.base_pay_ccy * fx;
  return manualGross !== null && Math.abs(manualGross - withoutAdjustments) < 0.005;
}

/** Reason text for a gross/net disagreement between manual and engine. */
function moneyMismatchReason(row, manual) {
  const manualGross = manual ? toNumber(manual.gross_usd) : null;
  const manualNet = manual ? toNumber(manual.net_usd) : null;
  const parts = [];
  if (manualGross !== null && row.gross_usd !== null) {
    parts.push('manual gross ' + manualGross.toFixed(2) + ' vs engine ' + row.gross_usd.toFixed(2));
  }
  if (manualNet !== null && row.net_usd !== null) {
    parts.push('manual net ' + manualNet.toFixed(2) + ' vs engine ' + row.net_usd.toFixed(2));
    const delta = round2(manualNet - row.net_usd);
    if (delta > 0) {
      parts.push('manual overpays by ' + delta.toFixed(2));
    } else if (delta < 0) {
      parts.push('manual underpays by ' + Math.abs(delta).toFixed(2));
    }
  }
  return (parts.length ? parts.join('; ') : 'manual figures differ from the engine') +
    ' — resolve before paying';
}

/** Reason text for a withholding/fee-only disagreement (money agrees). */
function componentMismatchReason(reconciliation) {
  const parts = ['gross and net agree, but components differ from the engine'];
  if (reconciliation.withholdingDiff !== null && reconciliation.withholdingDiff !== undefined) {
    parts.push('withholding off by ' + reconciliation.withholdingDiff.toFixed(2));
  }
  if (reconciliation.feeDiff !== null && reconciliation.feeDiff !== undefined) {
    parts.push('deducted fee off by ' + reconciliation.feeDiff.toFixed(2));
  }
  return parts.join('; ') + ' — needs review';
}

// ---------------------------------------------------------------------------
// Source validation pass: the four raw tabs, all checks in one place
// ---------------------------------------------------------------------------

/**
 * Validate the four raw tabs and assemble per-employee contexts for the
 * calculation phase. Critical per-employee errors end up in the employee's
 * flags (blocking the calculation); findings that belong to no employee row
 * (orphans, manual rows without an id) end up in globalFlags, which are
 * reported separately and never become payout_oct rows.
 * tabs: { employees, activity, adjustments, manual }
 * Returns { inputs: [ { employee, flags, inactive, window, selection,
 *                       adjustmentResult, manualRows } ],
 *           globalFlags: [ flag ] }.
 */
function validateSources(payload, config) {
  const employees = (payload && payload.employees) || [];
  const activity = (payload && payload.activity) || [];
  const adjustments = (payload && payload.adjustments) || [];
  const manual = (payload && payload.manual) || [];
  const globalFlags = [];

  // --- employees tab: id presence and duplicates ----------------------------
  const idCounts = {};
  const slackCounts = {};
  employees.forEach(function (emp) {
    if (emp.employee_id) {
      idCounts[emp.employee_id] = (idCounts[emp.employee_id] || 0) + 1;
    }
    if (emp.slack_user_id) {
      slackCounts[emp.slack_user_id] = (slackCounts[emp.slack_user_id] || 0) + 1;
    }
  });

  const perEmployeeFlags = {};   // key: employee_id or '__row_N' for id-less rows
  function flagsFor(key) {
    if (!perEmployeeFlags[key]) {
      perEmployeeFlags[key] = [];
    }
    return perEmployeeFlags[key];
  }

  employees.forEach(function (emp, index) {
    const key = emp.employee_id || ('__row_' + index);
    if (!emp.employee_id) {
      flagsFor(key).push(makeFlag('MISSING_EMPLOYEE_ID', 'employees row ' + (index + 1),
        'employees row ' + (index + 1) + ' has no employee_id; payroll cannot be calculated'));
    } else if (idCounts[emp.employee_id] > 1) {
      flagsFor(key).push(makeFlag('DUPLICATE_EMPLOYEE_ID', emp.employee_id,
        'duplicate employee ID ' + emp.employee_id + ' in the employees tab; calculation blocked'));
    }
    if (emp.slack_user_id && slackCounts[emp.slack_user_id] > 1) {
      flagsFor(key).push(makeFlag('DUPLICATE_SLACK_ID', emp.employee_id || ('employees row ' + (index + 1)),
        'slack_user_id ' + emp.slack_user_id + ' appears more than once in the employees tab' +
        ' (ticket routing may be ambiguous); calculation not blocked'));
    }
  });

  // --- route activity rows by employee_id; orphans -> global flags -----------
  const knownIds = {};
  employees.forEach(function (emp) {
    if (emp.employee_id) {
      knownIds[emp.employee_id] = true;
    }
  });
  const activityByEmployee = {};
  activity.forEach(function (row, index) {
    if (!row.employee_id || !knownIds[row.employee_id]) {
      globalFlags.push(makeFlag('ORPHAN_ACTIVITY',
        (row.employee_id || '?') + '/' + (row.import_id || ('row ' + (index + 1))),
        'activity row ' + (row.import_id || '(no import_id)') + ' references employee_id ' +
        (row.employee_id || '?') + ' which is not present in the employees tab; not paid'));
      return;
    }
    activityByEmployee[row.employee_id] = activityByEmployee[row.employee_id] || [];
    activityByEmployee[row.employee_id].push(row);
  });

  // --- route adjustment rows; orphans -> global flags -------------------------
  const adjustmentsByEmployee = {};
  adjustments.forEach(function (row, index) {
    if (!row.employee_id || !knownIds[row.employee_id]) {
      globalFlags.push(makeFlag('ORPHAN_ADJUSTMENT',
        (row.employee_id || '?') + '/' + (row.comment || row.type || ('row ' + (index + 1))),
        'adjustment references employee_id ' + (row.employee_id || '?') +
        ' which is not present in the employees tab; not applied'));
      return;
    }
    adjustmentsByEmployee[row.employee_id] = adjustmentsByEmployee[row.employee_id] || [];
    adjustmentsByEmployee[row.employee_id].push(row);
  });

  // --- manual tab: id presence, known employee, value validity ----------------
  const manualByEmployee = {};
  manual.forEach(function (row, index) {
    if (!row.employee_id) {
      globalFlags.push(makeFlag('MANUAL_ROW_NO_ID', 'manual row ' + (index + 1),
        'manual_payroll row ' + (index + 1) + ' has no employee_id'));
      return;
    }
    if (!knownIds[row.employee_id]) {
      globalFlags.push(makeFlag('ORPHAN_MANUAL_ROW', row.employee_id,
        'manual_payroll contains a row for employee_id ' + row.employee_id +
        ' which is not present in the employees tab'));
      return;
    }
    manualByEmployee[row.employee_id] = manualByEmployee[row.employee_id] || [];
    manualByEmployee[row.employee_id].push(row);
    // NOTE: invalid manual values are flagged during the comparison phase
    // (buildPayrollRow), NOT here: manual-tab errors never block the engine's
    // own calculation — the row is only excluded from comparison.
  });

  // --- per-employee source validation (record + activity + adjustments) -------
  const inputs = employees.map(function (emp, index) {
    const key = emp.employee_id || ('__row_' + index);
    const record = validateEmployeeRecord(emp, config);
    let flags = mergeFlags([], perEmployeeFlags[key] || []);
    flags = flags.concat(record.flags);

    // activity-based validations are skipped for inactive employees
    // (nothing in the month is payable — not an error)
    let selection = {
      paidUnits: 0, paidUnitsKnown: true, blocked: false, excludedUnits: 0,
      duplicateUnits: 0, capped: false, loggedUnits: 0, cap: null, flags: [],
    };
    if (!record.inactive) {
      selection = selectPayableActivity(activityByEmployee[emp.employee_id] || [], emp, record, config);
      flags = flags.concat(selection.flags);
    }

    const adjustmentResult = applyAdjustments(adjustmentsByEmployee[emp.employee_id] || [], emp, config);
    flags = flags.concat(adjustmentResult.flags);

    if (emp.contract_type === 'FTE_MONTHLY' && (activityByEmployee[emp.employee_id] || []).length > 0) {
      flags.push(makeFlag('FTE_ACTIVITY_PRESENT', emp.employee_id || ('employees row ' + (index + 1)),
        'activity exists for FTE_MONTHLY employee (' + activityByEmployee[emp.employee_id].length +
        ' row(s)); FTE pay is salary-based, activity ignored'));
    }

    return {
      employee: emp,
      flags: flags,
      inactive: record.inactive,
      window: record,
      selection: selection,
      adjustmentResult: adjustmentResult,
      manualRows: manualByEmployee[emp.employee_id] || [],
    };
  });

  return { inputs: inputs, globalFlags: globalFlags };
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/**
 * Process the full payload from n8n: the four raw tabs.
 * payload: { employees, activity, adjustments, manual, config? }
 * Returns { rows, summary, global_flags }.
 */
function processPayrollPayload(payload) {
  let config = PAYROLL_CONFIG;
  if (payload && payload.config) {
    config = deepMergeConfig(PAYROLL_CONFIG, payload.config);
  }
  const validated = validateSources(payload || {}, config);
  const rows = validated.inputs.map(function (input) {
    return buildPayrollRow(input, config);
  });

  // summary
  let mismatchCount = 0;
  let matchCount = 0;
  const statusCounts = { OK: 0, WARNING: 0, CRITICAL: 0 };
  let flagCount = 0;
  rows.forEach(function (r) {
    if (r.matches_manual === true) {
      matchCount++;
    }
    if (r.matches_manual === false) {
      mismatchCount++;
    }
    if (statusCounts[r.status] !== undefined) {
      statusCounts[r.status]++;
    }
    if (r.flags) {
      flagCount++;
    }
  });

  return {
    rows: rows,
    summary: {
      period: config.period.year + '-' + String(config.period.month).padStart(2, '0'),
      working_days: workingDaysInMonth(config.period.year, config.period.month),
      hours_cap: config.hoursCap.hoursPerDay * workingDaysInMonth(config.period.year, config.period.month),
      employees: validated.inputs.length,
      rows: rows.length,
      matches: matchCount,
      mismatches: mismatchCount,
      ok: statusCounts.OK,
      warning: statusCounts.WARNING,
      critical: statusCounts.CRITICAL,
      rows_with_flags: flagCount,
      global_flags: validated.globalFlags.length,
    },
    global_flags: validated.globalFlags.map(function (f) {
      return { code: f.code, severity: f.severity, target: f.target, reason: f.reason };
    }),
  };
}

function deepMergeConfig(base, override) {
  const result = {};
  Object.keys(base).forEach(function (key) {
    result[key] = base[key];
  });
  Object.keys(override || {}).forEach(function (key) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMergeConfig(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Web App entry points (Apps Script only — never called from Node tests)
// ---------------------------------------------------------------------------

function doPost(e) {
  let result;
  try {
    const payload = JSON.parse(e.postData.contents);
    result = processPayrollPayload(payload);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      service: 'payroll-engine',
      period: PAYROLL_CONFIG.period,
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
