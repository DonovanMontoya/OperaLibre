import { ExternalLink } from "lucide-react";

export function PrivacyPolicyLink({ role }: { role?: "menuitem" }) {
  return (
    <a className="privacy-policy-link" href="https://donovanmontoya.github.io/OperaLibre/privacy-policy.html" target="_blank" rel="noopener noreferrer" role={role}>
      Privacy policy <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}
