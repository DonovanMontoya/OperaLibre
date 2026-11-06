import type { LibationStatus } from "./types";

export function isLibationAdding({
  isLocal,
  confirmationPending,
  confirmationFailed
}: {
  isLocal: boolean;
  confirmationPending: boolean;
  confirmationFailed: boolean;
}) {
  return !isLocal && confirmationPending && !confirmationFailed;
}

/**
 * Whether refreshing Get books should ask Libation to check Audible. Without
 * a signed-in account, during a sign-in (which holds Libation), or with a
 * check already running, the refresh only rereads the last scan.
 */
export function canCheckAudible(status: LibationStatus | null, checkRunning: boolean) {
  if (!status?.enabled || checkRunning || status.pendingLogin) return false;
  if (status.accounts.some((account) => account.connectionState === "signing_in")) return false;
  return status.accounts.some((account) => account.authenticated);
}
