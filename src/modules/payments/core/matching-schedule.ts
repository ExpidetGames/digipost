// Owner: src/modules/payments (decisions/0041). How long after the last matching trigger (a
// finished invoice, an imported statement) the workspace-wide matching run starts. Every new
// trigger inside the window postpones the run again (trailing debounce), so a bulk upload of
// hundreds of receipts runs matching once instead of once per document.
export const MATCHING_DEBOUNCE_MS = 90_000;
