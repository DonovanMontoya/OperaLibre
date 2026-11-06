import { giftBrokerOrigin } from "./giftBrokerOrigin.ts";

export type GiftBrokerReadinessStep = {
  id: string;
  title: string;
  status: "blocked" | "local-check" | "owner-confirmed" | "unverified";
  label: string;
  detail: string;
};

/** Local hints only: no network probes, credentials, config writes or global
 * "ready" result. Origin syntax and an owner's statement cannot verify a host. */
export function giftBrokerReadiness(input: { transportSecure: boolean; brokerInput: string; ownerConfirmed: boolean }): GiftBrokerReadinessStep[] {
  const origin = input.brokerInput.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(input.brokerInput) ? giftBrokerOrigin(input.brokerInput) : null;
  return [
    { id: "gate", title: "Sharing availability", status: "blocked", label: "Disabled", detail: "Production gift sharing is disabled. This panel cannot activate it; local checks, saved configuration and successful cleanup do not prove that sharing works." },
    { id: "account", title: "Choose your own infrastructure and account", status: "unverified", label: "Owner setup required", detail: "Each server owner operates their own broker, provider account, credentials and billing. There is no shared OperaLibre hosting account or centralized billing. This guide deploys or enrolls nothing; private server settings are saved only through the separate explicit setup action." },
    { id: "transport", title: "Use a safe administration connection", status: input.transportSecure ? "local-check" : "blocked", label: input.transportSecure ? "Local transport check passed" : "Private setup and cleanup actions blocked", detail: input.transportSecure ? "The existing local check accepts this secure HTTPS page and direct HTTPS server URL. This does not test server reachability, authentication or recipient connectivity." : "Use a secure HTTPS page and a direct HTTPS server connection. HTTP, including Tailscale HTTP, and development proxies are not accepted for owner-secret setup or cleanup requests." },
    { id: "broker", title: "Check the broker address and ownership", status: !origin ? "blocked" : input.ownerConfirmed ? "owner-confirmed" : "unverified", label: !origin ? "Valid HTTPS origin needed" : input.ownerConfirmed ? "Owner trust stated; not independently verified" : "Address syntax checked; owner trust not confirmed", detail: !origin ? "Enter only an HTTPS origin, with no username, password, path, query or fragment. Do not paste gift links or credentials into this field." : "The address has HTTPS-origin syntax only. Confirm you own and trust this broker before using its owner secret. DNS, TLS identity, deployment, authorization and domain ownership are not probed or verified." },
    { id: "server", title: "Verify the sender server and outbound path", status: "unverified", label: "Integration testing required", detail: "The sender needs a supported server that stays online and can reach its owner-controlled broker. A Tailscale-only server still needs a verified outbound signaling and peer/relay path; access from your phone does not prove recipient access. No public port or phone-forwarding setup is performed here." },
    { id: "recipient", title: "Use a compatible recipient build", status: "unverified", label: "Platform verification required", detail: "The recipient needs an experimental gift-capable OperaLibre build. A regular store install may not support this flow. Server-free import, offline use, interruption recovery and native background behavior still require testing on the intended platforms; this panel checks none of them." },
    { id: "domain", title: "Review link opening and domain limits", status: "unverified", label: "No HTTPS association verified", detail: "The explicit operalibre://gift action is a custom scheme, not an HTTPS Universal Link or Android App Link. Another installed app can claim that scheme and receive the private gift link. Arbitrary owner Workers domains are not automatically associated with the app. Return to the original private link after installation; deferred restoration is not promised." },
    { id: "relay", title: "Test NAT failure, relay and the owner's budget", status: "unverified", label: "Relay and billing not verified", detail: "Direct peers can fail across NAT or firewalls; TURN fallback and large transfers must be configured and tested separately. This panel cannot verify TURN credentials, provider terms, quota, throughput or spending controls. There is no enforceable hard billing cap here and no guarantee of free operation. Review your own provider account before enabling anything." },
  ];
}
