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
