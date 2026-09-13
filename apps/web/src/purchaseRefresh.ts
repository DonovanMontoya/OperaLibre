/** Refresh each requested provider even when another provider fails. */
export async function refreshPurchaseSources(refreshes: Array<() => Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(refreshes.map(refresh => Promise.resolve().then(refresh)));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/** A new connection should not refresh unrelated, possibly expired accounts. */
export async function refreshLibroAccounts<T extends { email: string }>(
  accounts: T[],
  refresh: (account: T) => Promise<void>,
  email?: string
): Promise<void> {
  const selected = email === undefined ? accounts : accounts.filter(account => account.email.toLowerCase() === email.trim().toLowerCase());
  if (email !== undefined && !selected.length) throw new Error("Libro.fm account not found.");
  let failure: unknown;
  for (const account of selected) {
    try { await refresh(account); }
    catch (error) { failure = error; }
  }
  if (failure) throw failure;
}
