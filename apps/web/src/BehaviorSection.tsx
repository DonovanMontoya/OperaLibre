import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function BehaviorSection({ children }: { children: ReactNode }) {
  return (
    <details className="behavior-settings">
      <summary>
        <span>
          <strong>Behavior</strong>
          <small>Playback, navigation, and reading preferences</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="behavior-settings-body">{children}</div>
    </details>
  );
}
