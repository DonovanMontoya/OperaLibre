import { ChevronLeft } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

/**
 * The slim bar an iOS pushed page collapses into: once the page's own back
 * control has scrolled away, a back button and the title stay pinned at the top.
 * Only the phone layout shows it (see `.compact-navbar` in styles.css).
 */
export function CompactNavBar({
  scroller,
  threshold,
  title,
  backLabel,
  onBack
}: {
  scroller: RefObject<HTMLElement | null>;
  threshold: number;
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setShown(element.scrollTop > threshold);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [scroller, threshold]);

  return (
    <div className="compact-navbar" data-shown={shown ? "" : undefined} inert={!shown}>
      <button type="button" onClick={onBack}>
        <ChevronLeft size={22} aria-hidden="true" />
        <span>{backLabel}</span>
      </button>
      <strong>{title}</strong>
    </div>
  );
}
