import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountDeletion } from "../src/AccountDeletion";
import type { AuthUser } from "../src/types";
import "../src/styles.css";
const params = new URLSearchParams(location.search);
const user = { id: "fixture", username: "Reader", isOwner: params.has("owner") } as AuthUser;
function Fixture() {
  const [deleted, setDeleted] = useState(false);
  return <main style={{ maxWidth: 600, padding: 16, margin: "auto" }}>{deleted ? <h1>Signed out</h1> :
    <AccountDeletion user={user} supported={!params.has("unsupported")} unavailableReason="This mode has no OperaLibre account to delete."
      onDeleted={async () => { setDeleted(true); }} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
