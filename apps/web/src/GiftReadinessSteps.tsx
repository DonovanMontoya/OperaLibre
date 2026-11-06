import type { GiftBrokerReadinessStep } from "./giftBrokerReadiness";

export function GiftReadinessSteps({ steps }: { steps: GiftBrokerReadinessStep[] }) {
  return <ol>{steps.map(step => <li key={step.id}>
    <h4>{step.title}</h4>
    <p><strong>{step.label}.</strong> {step.detail}</p>
  </li>)}</ol>;
}
