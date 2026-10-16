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

const SHELF_ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SHELF_INITIAL_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

// The letter a title files under where the shelf is set out alphabetically.
// An accented letter joins the plain one only where the reader's language
// sorts them together; where it is a letter of its own (Å in Swedish), it
// keeps its own heading, so headings follow the order the titles are in.
// A digit or symbol files under "#".
export function titleInitial(title: string, collator: Intl.Collator = SHELF_INITIAL_COLLATOR) {
  const first = [...([...title.trim()][0] ?? "").toUpperCase()][0] ?? "";
  if (!/^\p{L}$/u.test(first)) return "#";
  if (first >= "A" && first <= "Z") return first;
  return SHELF_ALPHABET.find(letter => collator.compare(first, letter) === 0) ?? first;
}

// The jump index beside a lettered shelf: the whole alphabet in the shelf's
// reading order. Symbols file before A and other scripts after Z, as the
// title sort places them.
export function shelfLetterIndex(headings: string[], reversed: boolean) {
  const alphabet = [...SHELF_ALPHABET];
  const others = [...new Set(headings.filter(heading => !alphabet.includes(heading)))];
  if (reversed) others.reverse();
  const index = [...others.filter(heading => heading === "#"), ...alphabet, ...others.filter(heading => heading !== "#")];
  return reversed ? index.reverse() : index;
}
