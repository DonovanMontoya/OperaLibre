import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminPanel } from "../src/Admin";
import type { AuthUser } from "../src/types";
import "../src/styles.css";

const role = new URLSearchParams(location.search).get("role") ?? "owner";
const currentUser: AuthUser = {
  id: role, username: role, isAdmin: role !== "reader", isOwner: role === "owner",
  canApproveLibationRequests: false, allowedBookIds: null, libationAccess: "approval",
  shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: "2026-01-01T00:00:00Z"
};
function Fixture() {
  const [enabled, setEnabled] = useState(true);
  return <>
    <output aria-label="Sentence following">{enabled ? "Available" : "Unavailable"}</output>
    <AdminPanel currentUser={currentUser} books={[]} onUpload={() => {}}
      onRescan={async () => {}} onBeforeLibraryMutation={async () => {}}
      onBooksChanged={() => {}} onAlignmentChanged={status => setEnabled(status.enabled)} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
