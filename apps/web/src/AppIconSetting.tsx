import { Capacitor, registerPlugin } from "@capacitor/core";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

const icons = ["Classic", "Midnight", "Fern", "Marigold", "Porcelain", "Plum", "Lagoon", "Graphite"] as const;
type Icon = typeof icons[number];
function iconLabel(name: Icon) {
  if (name === "Graphite") return "White on black";
  if (name === "Porcelain") return "Black on white";
  return name;
}

const appIcon = registerPlugin<{
  current(): Promise<{ name: Icon | null }>;
  select(options: { name: Icon }): Promise<{ name: Icon }>;
}>("AppIcon");

export function AppIconSetting() {
  const [active, setActive] = useState<Icon | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!Capacitor.isPluginAvailable("AppIcon")) return;
    let mounted = true;
    void appIcon.current().then(({ name }) => {
      if (mounted) setActive(name);
    }).catch(() => {
      if (mounted) setError("Couldn’t read the current app icon.");
    });
    return () => { mounted = false; };
  }, []);

  async function select(name: Icon) {
    if (pending || active === name) return;
    setPending(true);
    setError("");
    try {
      setActive((await appIcon.select({ name })).name);
    } catch {
      setError("Couldn’t change the app icon. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (!active) return error ? <small role="alert">{error}</small> : null;
  return <details className="settings-themes">
    <summary><span><strong>App icon</strong><small>{iconLabel(active)}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="app-icon-grid" role="group" aria-label="App icon">
      {icons.map(name => <button key={name} type="button" aria-pressed={name === active}
        disabled={pending} onClick={() => void select(name)}>
        <span><img src={`/icons/choices/${name}.png`} alt="" width="52" height="52" />
          {name === active && <Check size={16} aria-hidden="true" />}</span>
        {iconLabel(name)}
      </button>)}
    </div>
    {error && <small role="alert">{error}</small>}
  </details>;
}
