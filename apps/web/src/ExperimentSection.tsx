import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Optional, collapsible tools belonging to an experiment. */
export function ExperimentSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="admin-experiment-section" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><ChevronDown size={15} aria-hidden="true" />{title}</summary>
      {open ? <div className="admin-experiment-section-content">{children}</div> : null}
    </details>
  );
}
