import { type FormEvent, useRef, useState } from "react";
import { isGiftBrokerTransportSecure, retryGiftBrokerRevocations } from "./api";
import { ExperimentSection } from "./ExperimentSection";
import { giftBrokerOrigin } from "./giftBrokerOrigin";

export function GiftBrokerExperiment() {
  const secretRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function retry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !isGiftBrokerTransportSecure()) return;
    const form = event.currentTarget;
    const origin = giftBrokerOrigin(String(new FormData(form).get("brokerOrigin") ?? ""));
    const secret = secretRef.current?.value ?? "";
    if (!origin || !secret || secret.length > 1024) {
      setMessage("Enter an HTTPS origin and an owner secret of up to 1024 characters.");
      return;
    }
    if (secretRef.current) secretRef.current.value = "";
    setBusy(true);
    setMessage("");
    try {
      const result = await retryGiftBrokerRevocations(origin, secret);
      setMessage(`Cleanup completed: ${result.completed}; still pending: ${result.pending}.`);
    } catch {
      setMessage("Cleanup could not be confirmed. The endpoint may be unavailable or the request may have timed out; some cleanup may still have happened.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article>
      <div className="admin-software-version-head"><div><span>Gift broker cleanup</span><strong>Experimental, not operational</strong></div><span className="admin-experimental-badge">Test only</span></div>
      <p>Gift sharing is not operational. This recovery tool targets a broker controlled by the owner; the owner chooses and operates the provider, which may charge for usage. Retrying sends requests to that broker.</p>
      <ExperimentSection title="Retry pending cleanup">
        <p>This test-only action requires an owner-controlled HTTPS broker origin and its owner secret. The secret is used for this request only and is cleared from the form when submitted.</p>
        {!isGiftBrokerTransportSecure() ? <p role="status">Cleanup is unavailable: open the app over HTTPS and connect directly to the server over HTTPS. HTTP connections, including Tailscale HTTP, and development proxy connections are not accepted.</p> : null}
        <form className="admin-sync-schedule-form" onSubmit={(event) => void retry(event)} autoComplete="off">
          <fieldset disabled={busy || !isGiftBrokerTransportSecure()}>
            <label>Broker HTTPS origin<input name="brokerOrigin" type="url" placeholder="https://broker.example" required /></label>
            <label>Broker owner secret<input ref={secretRef} type="password" autoComplete="new-password" maxLength={1024} required /></label>
            <div><button type="submit">{busy ? "Retrying…" : "Retry cleanup"}</button></div>
          </fieldset>
        </form>
        {message ? <p role="status">{message}</p> : null}
      </ExperimentSection>
    </article>
  );
}
