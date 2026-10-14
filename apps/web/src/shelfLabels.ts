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

// The letter a title files under where the shelf is set out alphabetically:
// its first letter without accents, or "#" for a digit or symbol.
export function titleInitial(title: string) {
  const first = [...title.trim().normalize("NFD")][0]?.toUpperCase() ?? "";
  return /^\p{L}$/u.test(first) ? first : "#";
}

// The jump index beside a lettered shelf: the whole alphabet in the shelf's
// reading order. Symbols file before A and other scripts after Z, as the
// title sort places them.
export function shelfLetterIndex(headings: string[], reversed: boolean) {
  const alphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const others = [...new Set(headings.filter(heading => !alphabet.includes(heading)))];
  if (reversed) others.reverse();
  const index = [...others.filter(heading => heading === "#"), ...alphabet, ...others.filter(heading => heading !== "#")];
  return reversed ? index.reverse() : index;
}
