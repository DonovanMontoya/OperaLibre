import { type FormEvent, useRef, useState } from "react";
import { isGiftBrokerTransportSecure, retryGiftBrokerRevocations } from "./api";
import { ExperimentSection } from "./ExperimentSection";
import { giftBrokerOrigin } from "./giftBrokerOrigin";
import { giftBrokerReadiness } from "./giftBrokerReadiness";
import { GiftBrokerReadiness } from "./GiftBrokerReadiness";

export function GiftBrokerExperiment() {
  const secretRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [brokerInput, setBrokerInput] = useState("");
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const secure = isGiftBrokerTransportSecure();
  const steps = giftBrokerReadiness({ transportSecure: secure, brokerInput, ownerConfirmed });

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
      <div className="admin-software-version-head"><div><span>Book gift owner setup</span><strong>Experimental, not operational</strong></div><span className="admin-experimental-badge">Test only</span></div>
      <p>Plan an optional broker on infrastructure and a provider account you control. You are responsible for its credentials, costs and operation, not every OperaLibre installation. There is no centralized hosting or billing.</p>
      <p>This development-only guide does not enable sharing, deploy anything or save configuration. Editing these fields performs no network requests. Only the explicit cleanup action below sends a request.</p>
      <form className="admin-sync-schedule-form" onSubmit={(event) => void retry(event)} autoComplete="off">
        <label>Broker HTTPS origin<input name="brokerOrigin" type="url" value={brokerInput} onChange={event => { setBrokerInput(event.currentTarget.value); setOwnerConfirmed(false); setMessage(""); }} placeholder="https://broker.example" maxLength={2048} required disabled={busy} /></label>
        <label className="admin-all-access"><input type="checkbox" style={{ width: "auto", minHeight: 0, flexShrink: 0 }} checked={ownerConfirmed} onChange={event => setOwnerConfirmed(event.currentTarget.checked)} disabled={busy} /><span>I control and trust this broker. This is my statement, not a verified ownership check.</span></label>
        <p role="status">{steps.find(step => step.id === "broker")!.label}. Sharing remains disabled regardless of these local checks.</p>
        <ExperimentSection title="Guided readiness and remaining blockers">
          <GiftBrokerReadiness steps={steps} />
        </ExperimentSection>
        <ExperimentSection title="Retry pending cleanup">
          <p>This test-only action sends the entered origin and owner secret to your connected OperaLibre server to retry its queued revocations. That server contacts the owner-controlled broker. It does not configure the broker or test gift transfer.</p>
          <p>The secret is used for this request only, is never saved or logged by this form, and is cleared when a valid cleanup request is submitted. Only enter it for a broker you own and trust.</p>
          {!secure ? <p role="status">Cleanup is unavailable: open the app over HTTPS and connect directly to the server over HTTPS. HTTP connections, including Tailscale HTTP, and development proxy connections are not accepted.</p> : null}
          <fieldset disabled={busy || !secure}>
            <label>Broker owner secret<input ref={secretRef} type="password" autoComplete="new-password" maxLength={1024} required /></label>
            <div><button type="submit">{busy ? "Retrying…" : "Retry cleanup"}</button></div>
          </fieldset>
          {message ? <p role="status">{message}</p> : null}
        </ExperimentSection>
      </form>
    </article>
  );
}
