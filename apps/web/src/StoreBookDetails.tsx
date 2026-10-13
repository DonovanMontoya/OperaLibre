import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShoppingBag, X } from "lucide-react";
import { formatDurationLabel } from "./formatting";
import { haptic } from "./native";
import type { StoreBookFacts } from "./storeBookFacts";
import { useModalFocus } from "./useModalFocus";

/** The book page for a store purchase, shaped like a server book's details but
    built around getting the book onto the server. The caller passes its live
    action, so the page follows an import as it progresses. */
export function StoreBookDetails({ facts, cover, action, status, hint, onClose }: {
  facts: StoreBookFacts;
  cover: ReactNode;
  action: ReactNode;
  status?: ReactNode;
  hint: string;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (description) setCanExpand(description.scrollHeight > description.clientHeight + 1);
  }, [facts.description]);

  const colophon = [
    { label: "Runtime", value: formatDurationLabel(facts.runtimeSeconds) },
    { label: "Publisher", value: facts.publisher },
    { label: facts.accounts.length > 1 ? "Accounts" : "Account", value: facts.accounts.join(", ") || null },
    { label: facts.identifier.label, value: facts.identifier.value }
  ].filter(fact => fact.value);

  return createPortal(<div className="modal-scrim store-book-scrim" role="presentation">
    <section ref={dialogRef} tabIndex={-1} className="modal-card store-book-details" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="icon-button store-book-close" aria-label="Close book details" onClick={onClose}><X size={18} /></button>
      <div className="store-book-heading">
        <div className="store-book-cover">{cover}</div>
        <div className="store-book-meta">
          <span className="store-book-eyebrow"><ShoppingBag size={13} /> {facts.store} purchase</span>
          <h2 id={titleId}>{facts.title}</h2>
          {facts.subtitle ? <p className="store-book-subtitle">{facts.subtitle}</p> : null}
          {facts.author || facts.narrator ? <p className="store-book-credits">
            {facts.author ? <span>{facts.author}</span> : null}
            {facts.narrator ? <span>Narrated by {facts.narrator}</span> : null}
          </p> : null}
        </div>
      </div>
      <div className="store-book-cta">
        <div className="store-book-action">{action}</div>
        {status}
        <p className="store-book-hint">{hint}</p>
      </div>
      {colophon.length ? <dl className="store-book-colophon">
        {colophon.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd title={fact.value ?? undefined}>{fact.value}</dd></div>)}
      </dl> : null}
      {facts.description ? <div className="store-book-description">
        <p ref={descriptionRef} id={descriptionId} className={`book-description ${expanded ? "" : "clamped"}`}>{facts.description}</p>
        {canExpand || expanded ? <button type="button" className="book-description-toggle" aria-controls={descriptionId} aria-expanded={expanded}
          onClick={() => { haptic("light"); setExpanded(value => !value); }}>{expanded ? "Less" : "More"}</button> : null}
      </div> : null}
    </section>
  </div>, document.body);
}
