import type { ReactNode } from "react";
import type { SyncProblem as Problem } from "./syncQuality";

/**
 * A sync problem in plain words, with the raw error folded away under
 * Technical details. `brief` leaves out the explanation and advice when
 * something nearby already gives them.
 */
export function SyncProblem({ problem, className, brief, children }: {
  problem: Problem;
  className?: string;
  brief?: boolean;
  children?: ReactNode;
}) {
  const text = (brief ? problem.notes : [problem.explanation, ...problem.notes, problem.action]).filter(Boolean).join(" ");
  return (
    <div className={className ? `sync-problem ${className}` : "sync-problem"}>
      <p><span className="sync-problem-title">{problem.title}</span> {text}</p>
      {children}
      {problem.detail ? (
        <details className="sync-problem-details">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
