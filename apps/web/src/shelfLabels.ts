// Built once: localeCompare constructs a collator on every call, and sorting a
// large shelf compares thousands of times.
const SHELF_LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareShelfLabels(left: string | null | undefined, right: string | null | undefined) {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return SHELF_LABEL_COLLATOR.compare(a, b);
}

