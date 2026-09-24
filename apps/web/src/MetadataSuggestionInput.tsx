import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { matchingMetadataNames } from "./metadataSuggestions";

export function MetadataSuggestionInput({
  label,
  names,
  onChange,
  placeholder,
  suggestionsLabel,
  value
}: {
  label: string;
  names: readonly string[];
  onChange: (value: string) => void;
  placeholder?: string;
  suggestionsLabel: string;
  value: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 208 });
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = open ? matchingMetadataNames(names, value) : [];

  useLayoutEffect(() => {
    if (!matches.length || !document.documentElement.classList.contains("native-app")) return;
    const field = fieldRef.current?.getBoundingClientRect();
    const scroll = fieldRef.current?.closest(".metadata-edit-form")?.getBoundingClientRect();
    if (!field || !scroll) return;
    const below = Math.max(0, scroll.bottom - field.bottom);
    const above = Math.max(0, field.top - scroll.top);
    const openAbove = below < Math.min(listRef.current?.scrollHeight ?? 120, 120) && above > below;
    const maxHeight = Math.max(44, Math.min(208, (openAbove ? above : below) - 6));
    setPlacement((current) => current.above === openAbove && current.maxHeight === maxHeight
      ? current
      : { above: openAbove, maxHeight });
  }, [matches.length, value]);

  useEffect(() => () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
  }, []);

  function select(name: string) {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
    onChange(name);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActiveIndex((index) => event.key === "ArrowDown"
        ? (index + 1) % matches.length
        : (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && activeIndex >= 0 && matches[activeIndex]) {
      event.preventDefault();
      select(matches[activeIndex]);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      // On touch keyboards, the next focused element can be reported as null.
      // Leave the option mounted long enough for its tap/click to complete.
      if (blurTimer.current !== null) clearTimeout(blurTimer.current);
      blurTimer.current = setTimeout(() => {
        setOpen(false);
        setActiveIndex(-1);
        blurTimer.current = null;
      }, 150);
    }
  }

  return (
    <div className="metadata-suggestion-field" onBlur={handleBlur} ref={fieldRef}>
      <input
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => {
          if (blurTimer.current !== null) clearTimeout(blurTimer.current);
          blurTimer.current = null;
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={matches.length > 0}
        aria-controls={matches.length ? id : undefined}
        aria-activedescendant={activeIndex >= 0 && matches[activeIndex] ? `${id}-${activeIndex}` : undefined}
      />
      {matches.length ? (
        <div
          className={`metadata-suggestions${placement.above ? " above" : ""}`}
          role="listbox"
          id={id}
          aria-label={suggestionsLabel}
          ref={listRef}
          style={document.documentElement.classList.contains("native-app") ? { maxHeight: placement.maxHeight } : undefined}
        >
          {matches.map((name, index) => (
            <button
              type="button"
              role="option"
              id={`${id}-${index}`}
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : undefined}
              key={name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(name)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
