import { useEffect, useId, useRef, useState } from "react";
import { haptic } from "./native";

export function BookCredits({ author, narrator, trackCount }: {
  author: string | null;
  narrator: string | null;
  trackCount: number;
}) {
  const narratorId = useId();
  const measureRef = useRef<HTMLSpanElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;
    let disposed = false;
    const update = () => {
      if (disposed || measure.getBoundingClientRect().width === 0) return;
      const overflows = measure.scrollHeight > measure.clientHeight + 1;
      setCanExpand(overflows);
      if (!overflows) setExpanded(false);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    void document.fonts.ready.then(update);
    document.fonts.addEventListener("loadingdone", update);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [narrator]);

  return (
    <p className="book-credits" title={[author, narrator ? `Narrated by ${narrator}` : null].filter(Boolean).join(" • ") || undefined}>
      {author ? <span className="book-author">{author}</span> : null}
      {narrator ? <>
        <span id={narratorId} className={`book-narrator${canExpand ? " expandable" : ""}${canExpand && !expanded ? " clamped" : ""}`}>
          Narrated by {narrator}
        </span>
        <span ref={measureRef} className="book-narrator book-narrator-measure clamped" aria-hidden="true">
          Narrated by {narrator}
        </span>
        {canExpand ? <button
          type="button"
          className="book-description-toggle book-credits-toggle"
          aria-controls={narratorId}
          aria-expanded={expanded}
          onClick={() => {
            haptic("light");
            setExpanded(value => !value);
          }}
        >{expanded ? "Show less" : "Show all narrators"}</button> : null}
      </> : null}
      {!author && !narrator ? <span>{trackCount} tracks</span> : null}
    </p>
  );
}
