import { demoMediaUrl } from "./demo";

export function DemoMediaCredits() {
  return (
    <p className="settings-hint" aria-label="Demo media credits">
      <strong>Public-domain demo (USA).</strong>{" "}
      Audio: Kristen McQuillin for <a href="https://librivox.org/alices-adventures-in-wonderland-by-lewis-carroll/" target="_blank" rel="noopener noreferrer">LibriVox</a>.{" "}
      Ebook: <a href="https://www.gutenberg.org/ebooks/11" target="_blank" rel="noopener noreferrer">Project Gutenberg</a>.{" "}
      <a href={demoMediaUrl("/demo/alice/credits.html")} target="_blank" rel="noopener noreferrer">Sources, credits, and license</a>.
    </p>
  );
}
