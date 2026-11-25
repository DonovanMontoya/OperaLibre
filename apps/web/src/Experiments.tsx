import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, LoaderCircle, RefreshCcw, Trash2 } from "lucide-react";
import {
  getAgentAccessStatus,
  getBookGiftsStatus,
  getChapterNotesStatus,
  isGiftBrokerTransportSecure,
  setAgentAccessEnabled,
  setBookGiftsEnabled,
  setChapterNotesEnabled,
  type AgentAccessStatus,
  type BookGiftsStatus,
  type ChapterNotesStatus
} from "./api";
import { ChapterNotesProviderForm } from "./ChapterNotesExperiment";
import { CloudRecognition } from "./CloudRecognition";
import { isDemoMode } from "./demo";
import { countLabel, errorMessage, formatFileSize } from "./formatting";
import { GiftOwnerConfiguration } from "./GiftOwnerConfiguration";
import { SyncJobMonitor } from "./SyncJobMonitor";
import type { Book, SyncAddonStatus } from "./types";

const GIFT_GUIDE = "https://donovanmontoya.github.io/OperaLibre/book-gifts.html";

type ExperimentId = "follow" | "assistants" | "gifts" | "notes";
type Tone = "on" | "attention" | "off";
type State = { label: string; tone: Tone };
type Fact = [label: string, detail: ReactNode];

const NAMES: Record<ExperimentId, string> = {
  follow: "Follow along",
  assistants: "AI assistants",
  gifts: "Book gifts",
  notes: "Chapter notes"
};

const CHECKING: State = { label: "Checking…", tone: "off" };
const onOff = (enabled: boolean): State => enabled ? { label: "On", tone: "on" } : { label: "Off", tone: "off" };

/** The follow-along add-on is installed, updated, and removed by Administration, which owns its status. */
export type FollowAlongControls = {
  status: SyncAddonStatus | null;
  checking: boolean;
  busy: "install" | "toggle" | "remove" | null;
  onCheck: () => void;
  onInstall: () => void;
  onToggle: () => void;
  onRemove: () => void;
};

/** One experiment's switch: its status, and the change in flight or the reason it failed. */
function useExperimentSwitch<T extends { enabled: boolean }>(load: () => Promise<T>, save: (enabled: boolean) => Promise<T>, failure: string, wanted: boolean) {
  const [status, setStatus] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    load().then(
      loaded => { if (!cancelled) setStatus(loaded); },
      (reason: unknown) => { if (!cancelled) setError(errorMessage(reason, failure)); }
    );
    return () => { cancelled = true; };
    // The loaders are module functions, so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  async function toggle() {
    if (!status || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await save(!status.enabled));
    } catch (reason) {
      setError(errorMessage(reason, failure));
    } finally {
      setBusy(false);
    }
  }

  return { status, setStatus, busy, error, toggle };
}

/**
 * Administration → Experiments. The experiments are listed with their state,
 * and one is open at a time. Where Administration has a column of its own for
 * navigation, the list goes there (`listSlot`) beside the open experiment;
 * elsewhere the list is the page, and choosing one opens it in its place.
 */
export function Experiments({ isOwner, books, onOpenBook, follow, listSlot }: {
  isOwner: boolean;
  books: Book[];
  onOpenBook?: (bookId: string) => void;
  follow: FollowAlongControls;
  listSlot: HTMLElement | null;
}) {
  const demo = isDemoMode();
  const showGifts = isOwner && !demo;
  const showNotes = !demo;
  const assistants = useExperimentSwitch<AgentAccessStatus>(getAgentAccessStatus, setAgentAccessEnabled, "Could not change AI assistants.", true);
  const gifts = useExperimentSwitch<BookGiftsStatus>(getBookGiftsStatus, setBookGiftsEnabled, "Could not change book gifts.", showGifts);
  const notes = useExperimentSwitch<ChapterNotesStatus>(getChapterNotesStatus, setChapterNotesEnabled, "Could not change chapter notes.", showNotes);
  const [cloudRecognition, setCloudRecognition] = useState(false);
  const [picked, setPicked] = useState<ExperimentId | null>(null);

  const addon = follow.status;
  const states: Record<ExperimentId, State> = {
    follow: !addon ? CHECKING : !addon.installed ? { label: "Not installed", tone: "off" } : onOff(addon.enabled),
    assistants: assistants.status ? onOff(assistants.status.enabled) : assistants.error ? { label: "Unavailable", tone: "off" } : CHECKING,
    gifts: !gifts.status ? CHECKING : gifts.status.enabled && !gifts.status.configured ? { label: "Needs setup", tone: "attention" } : onOff(gifts.status.enabled),
    notes: notes.status ? onOff(notes.status.enabled) : CHECKING
  };
  const ids: ExperimentId[] = ["follow", "assistants", ...(showGifts ? ["gifts" as const] : []), ...(showNotes ? ["notes" as const] : [])];
  const shown = picked ?? ids[0];

  // Beside the open experiment the list marks which one that is; as a page of its own it marks none.
  const list = (beside: boolean) => (
    <ul className="experiment-list">
      {ids.map(id => (
        <li key={id}>
          <button type="button" className={beside && id === shown ? "selected" : undefined} aria-current={beside && id === shown ? "true" : undefined} onClick={() => setPicked(id)}>
            <span className="experiment-list-name">{NAMES[id]}</span>
            <ExperimentState state={states[id]} />
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );

  // Opening an experiment from the page-sized list hides the button that was
  // pressed, and going back hides the back button. Focus follows to what
  // replaced it; where the list stays beside the panel, focus stays put.
  const root = useRef<HTMLDivElement>(null);
  const firstPick = useRef(true);
  useEffect(() => {
    if (firstPick.current) { firstPick.current = false; return; }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.offsetParent !== null) return;
    root.current?.querySelector<HTMLElement>(picked ? ".experiment-panel" : ".experiment-index button")?.focus({ preventScroll: true });
  }, [picked]);

  const back = (
    <button type="button" className="experiment-back" onClick={() => setPicked(null)}>
      <ChevronLeft size={15} aria-hidden="true" />All experiments
    </button>
  );

  function switchFor(experiment: { status: { enabled: boolean } | null; busy: boolean; toggle: () => Promise<void> }, id: ExperimentId, confirmOff?: string) {
    if (!isOwner) return null;
    return (
      <ExperimentSwitch
        label={NAMES[id]}
        checked={experiment.status?.enabled === true}
        busy={experiment.status === null || experiment.busy}
        onChange={() => {
          if (confirmOff && experiment.status?.enabled && !window.confirm(confirmOff)) return;
          void experiment.toggle();
        }}
      />
    );
  }

  return (
    <div ref={root} className="admin-content admin-experiments" data-picked={picked !== null}>
      {listSlot ? createPortal(<div className="experiment-side" role="group" aria-label="Experiments">{list(true)}</div>, listSlot) : null}
      <section className="admin-card experiment-index">
        <h2>Experiments</h2>
        <p>Optional features, off until an owner turns them on. They may change while they are refined.</p>
        {list(false)}
      </section>

      {shown === "follow" ? (
        <FollowAlong back={back} state={states.follow} isOwner={isOwner} follow={follow} books={books} onOpenBook={onOpenBook} cloudRecognition={cloudRecognition} onCloudRecognition={setCloudRecognition} />
      ) : null}

      {shown === "assistants" ? (
        <ExperimentPanel
          back={back}
          name={NAMES.assistants}
          state={states.assistants}
          control={switchFor(assistants, "assistants")}
          isOwner={isOwner}
          summary="Lets each listener connect an AI assistant they already use, such as Claude or Codex."
          facts={[
            ["What it can do", "Spoiler-free recaps, what to read next, series and achievements, and, if the listener allows it, getting books they own onto this server."],
            ["Who decides", "Each listener chooses what their assistant may do in Settings. An assistant never sees other listeners."],
            ["What leaves your server", "What an assistant reads is sent to the company that runs it."]
          ]}
          error={assistants.error}
        >
          <p className="admin-experiment-detail">
            {assistants.status?.enabled
              ? `${assistants.status.assistants
                ? `${countLabel(assistants.status.assistants, "assistant")} connected by ${countLabel(assistants.status.listeners, "listener")}.`
                : "No one has connected an assistant yet."} Turning this off stops them until it is turned back on.`
              : "Built into the server, so there is nothing to install."}
          </p>
        </ExperimentPanel>
      ) : null}

      {shown === "gifts" ? (
        <ExperimentPanel
          back={back}
          name={NAMES.gifts}
          state={states.gifts}
          control={switchFor(gifts, "gifts", "Turn off book gifts?\n\nGifts being sent stop, and links you have already shared stop working until this is turned back on.")}
          isOwner={isOwner}
          summary="Send a book to someone as a one-time link. They open it in the OperaLibre app, unwrap it, and keep their own copy, with no account on this server."
          facts={[
            ["How the book travels", "Straight from this server to their device, so nothing needs to be port forwarded."],
            ["What it needs", <>A small broker that you run yourself introduces the two. It never sees the book. Setting it up is a one-time step: <a href={GIFT_GUIDE} target="_blank" rel="noreferrer">read the setup guide</a>.</>],
            ["Your responsibility", "Only share books you have the right to share."]
          ]}
          error={gifts.error}
        >
          {gifts.status?.enabled ? (
            <GiftOwnerConfiguration
              secure={isGiftBrokerTransportSecure()}
              onChanged={() => void getBookGiftsStatus().then(gifts.setStatus)}
            />
          ) : null}
        </ExperimentPanel>
      ) : null}

      {shown === "notes" ? (
        <ExperimentPanel
          back={back}
          name={NAMES.notes}
          state={states.notes}
          control={switchFor(notes, "notes")}
          isOwner={isOwner}
          summary="Gives each chapter a spoiler-free synopsis, a full summary, and the people and places in it."
          facts={[
            ["Who sees them", "Listeners on the book's page, and connected AI assistants, only as far as the listener has got."],
            ["Where the text comes from", `Books with a follow-along map use their own text. Other books are transcribed on this server, which needs the follow-along add-on${notes.status?.enabled ? (notes.status.transcriptionAvailable ? ". It is ready." : ". It is not installed or is off.") : "."}`],
            ["What leaves your server", "A chapter's text goes to the model you choose, only when an administrator makes notes for that book. Without a model, books are transcribed and assistants write their own recaps."]
          ]}
          error={notes.error}
        >
          {notes.status?.enabled ? (
            <div className="experiment-block">
              <div className="experiment-block-head">
                <h3>Model that writes the notes</h3>
                <span>{notes.status.provider ? notes.status.provider.model : "Transcripts only"}</span>
              </div>
              {isOwner ? <ChapterNotesProviderForm status={notes.status} onSaved={notes.setStatus} /> : null}
            </div>
          ) : null}
        </ExperimentPanel>
      ) : null}
    </div>
  );
}

function ExperimentState({ state }: { state: State }) {
  return <span className={`experiment-state experiment-state-${state.tone}`}>{state.label}</span>;
}

function ExperimentSwitch({ label, checked, busy, onChange }: { label: string; checked: boolean; busy: boolean; onChange: () => void }) {
  return (
    <button type="button" className="experiment-switch" role="switch" aria-checked={checked} aria-label={label} disabled={busy} onClick={onChange}>
      <span aria-hidden="true" />
    </button>
  );
}

/** The open experiment: what it is, its switch, what an owner weighs before turning it on, then its own settings. */
function ExperimentPanel({ back, name, state, control, isOwner, summary, facts, error, children }: {
  back: ReactNode;
  name: string;
  state: State;
  control: ReactNode;
  isOwner: boolean;
  summary: string;
  facts: Fact[];
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <section className="admin-card experiment-panel" aria-label={name} tabIndex={-1}>
      {back}
      <header className="experiment-head">
        <h2>{name}</h2>
        <div className="experiment-head-control">
          <ExperimentState state={state} />
          {control}
        </div>
      </header>
      <p className="experiment-summary">{summary}</p>
      {isOwner ? null : <p className="admin-experiment-detail">Only an owner can change experiments.</p>}
      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
      <dl className="experiment-facts">
        {facts.map(([label, detail]) => <div key={label}><dt>{label}</dt><dd>{detail}</dd></div>)}
      </dl>
      {/* The settings inside were styled as children of the old experiment list. */}
      <div className="admin-experiment-list experiment-body">{children}</div>
    </section>
  );
}

type FollowTab = "recognition" | "sync" | "addon";

function FollowAlong({ back, state, isOwner, follow, books, onOpenBook, cloudRecognition, onCloudRecognition }: {
  back: ReactNode;
  state: State;
  isOwner: boolean;
  follow: FollowAlongControls;
  books: Book[];
  onOpenBook?: (bookId: string) => void;
  cloudRecognition: boolean;
  onCloudRecognition: (enabled: boolean) => void;
}) {
  const addon = follow.status;
  const installed = addon?.installed === true;
  const [chosen, setChosen] = useState<FollowTab | null>(null);
  const tabs: FollowTab[] = installed ? ["recognition", "sync", "addon"] : ["addon", "sync"];
  const tab = chosen && tabs.includes(chosen) ? chosen : tabs[0];
  const version = follow.checking && !addon
    ? "Checking…"
    : installed
      ? addon.installedVersion ? `Version ${addon.installedVersion}` : "External installation"
      : "Not installed";
  const canUpdate = isOwner && !!addon?.canInstall && installed && addon.updateAvailable;
  const canInstall = isOwner && !!addon?.canInstall && !installed;
  const labels: Record<FollowTab, string> = {
    recognition: "Speech recognition",
    sync: "Sync books",
    addon: canUpdate ? "Add-on (update available)" : "Add-on"
  };

  const control = !isOwner ? null : installed && (addon.canToggle ?? addon.managed) ? (
    <ExperimentSwitch label={NAMES.follow} checked={addon.enabled} busy={follow.busy !== null} onChange={follow.onToggle} />
  ) : canInstall ? (
    <button type="button" className="experiment-primary" disabled={follow.busy !== null} onClick={follow.onInstall}>
      {follow.busy === "install" ? <LoaderCircle size={15} className="spin-icon" /> : <Download size={15} />}
      {follow.busy === "install" ? "Installing…" : "Install add-on"}
    </button>
  ) : null;

  return (
    <ExperimentPanel
      back={back}
      name={NAMES.follow}
      state={state}
      control={control}
      isOwner={isOwner}
      summary="Highlights each sentence in the EPUB reader as it is read, plays from a sentence you tap, and turns the pages."
      facts={[
        ["Where it runs", cloudRecognition
          ? "Speech recognition runs at OpenAI, with your API key. Matching the audio to the text stays on this server."
          : "On this server, using local speech recognition and forced alignment. Audio stays on this server."],
        ["Server load", "Jobs run one at a time and can use substantial CPU, memory, and disk space. On smaller servers, generation may affect playback."],
        ["When it is off", "EPUBs open beside the audio without Follow, including books that already have a sync map."]
      ]}
    >
      <div className="experiment-tabs" role="tablist" aria-label="Follow along settings">
        {tabs.map(id => (
          <button key={id} type="button" role="tab" id={`follow-tab-${id}`} aria-selected={tab === id} aria-controls={`follow-panel-${id}`} className={tab === id ? "selected" : undefined} onClick={() => setChosen(id)}>
            {labels[id]}
          </button>
        ))}
      </div>

      {/* Stays mounted while another tab shows: what it reports decides "Where it runs" above.
          An updated add-on can gain recognition options, so its choices are read again. */}
      {installed ? (
        <div role="tabpanel" id="follow-panel-recognition" aria-labelledby="follow-tab-recognition" hidden={tab !== "recognition"}>
          <CloudRecognition key={addon.installedVersion ?? "external"} isOwner={isOwner} onChange={onCloudRecognition} />
        </div>
      ) : null}

      {/* The monitor polls the server, so it exists only while its tab shows. */}
      {tab === "sync" ? (
        <div role="tabpanel" id="follow-panel-sync" aria-labelledby="follow-tab-sync">
          <SyncJobMonitor books={books} onOpenBook={onOpenBook} syncEnabled={addon?.enabled === true} />
        </div>
      ) : null}

      {tab === "addon" ? (
        <div role="tabpanel" id="follow-panel-addon" aria-labelledby="follow-tab-addon" className="experiment-block">
          <div className="experiment-block-head">
            <h3>{version}</h3>
            {canUpdate && addon.latestVersion ? <span>Version {addon.latestVersion} is available</span> : null}
          </div>
          <p className="admin-experiment-detail">
            Follow along installs separately so the normal OperaLibre server stays small.
            {addon?.packageBytes ? ` Download size: ${formatFileSize(addon.packageBytes)}. The recognition model is downloaded separately on first use.` : ""}
          </p>
          {addon?.message ? <p className="admin-experiment-detail">{addon.message}</p> : null}
          <div className="admin-update-actions">
            {canUpdate ? (
              <button type="button" disabled={follow.busy !== null} onClick={follow.onInstall}>
                {follow.busy === "install" ? <LoaderCircle size={15} className="spin-icon" /> : <Download size={15} />}
                {follow.busy === "install" ? "Installing…" : "Update add-on"}
              </button>
            ) : null}
            <button type="button" className="quiet-button" disabled={follow.checking || follow.busy !== null} onClick={follow.onCheck}>
              {follow.checking ? <LoaderCircle size={14} className="spin-icon" /> : <RefreshCcw size={14} />}
              {follow.checking ? "Checking…" : "Check for updates"}
            </button>
            {addon?.releaseUrl ? (
              <a className="quiet-button" href={addon.releaseUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Release details
              </a>
            ) : null}
            {isOwner && installed && addon.managed ? (
              <button type="button" className="danger" disabled={follow.busy !== null} onClick={follow.onRemove}>
                {follow.busy === "remove" ? <LoaderCircle size={15} className="spin-icon" /> : <Trash2 size={15} />}
                {follow.busy === "remove" ? "Removing…" : "Remove add-on"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </ExperimentPanel>
  );
}
