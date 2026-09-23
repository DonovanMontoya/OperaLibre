import type { useCarPlay } from "./useCarPlay";
import type { useFinishFeed } from "./useFinishFeed";
import type { useOfflineDownloads } from "./useOfflineDownloads";
import type { usePurchases } from "./usePurchases";
import type { useReaderPreferences } from "./useReaderPreferences";
import type { useShelf } from "./useShelf";
import type { useUploads } from "./useUploads";
import { PULL_REFRESH_THRESHOLD } from "./usePullToRefresh";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudDownload,
  ExternalLink,
  FolderOpen,
  KeyRound,
  LayoutGrid,
  Library,
  List,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Network,
  PanelLeftClose,
  RefreshCcw,
  Rows3,
  Search,
  SlidersHorizontal,
  Upload,
  X
} from "lucide-react";
import { haptic } from "./native";
import { finishAnnouncement, finishedAgoLabel } from "./finishFeed";
import { createPortal } from "react-dom";
import { isSortModeSupported, type LibrarySource, SORT_OPTIONS, type SortMode } from "./shelfSort";
import { SHELF_VIEW_MODE_OPTIONS } from "./shelfView";
import { SHELF_STATUS_OPTIONS, toggleShelfFacet } from "./shelfFilters";
import { ShelfBookList, ShelfFacetGroup } from "./ShelfBookList";
import { isPendingJob, jobDetailLines, jobStateLabel, jobSummary, jobTitle } from "./jobLabels";
import { formatElapsed, formatMinutes } from "./formatting";
import { LibroCatalog } from "./LibroCatalog";
import { getDeviceBooks, mergeDeviceAndServerBooks } from "./localLibrary";
import { hasUserConfiguredServer, SERVER_SETUP_GUIDE_URL } from "./api";
import { CONNECT_PROMPT_DISMISSED_KEY, writeStoredValue } from "./appStorage";
import { isLibationAdding } from "./libationState";
import { LibationCoverArt } from "./CoverArt";
import type { AuthUser, Book } from "./types";
import type { NativeTab } from "./nativeTabs";
import type { Dispatch, ReactNode, RefObject, SetStateAction, TouchEvent } from "react";
import type { ServerCapabilities } from "./serverCapabilities";

export function LibraryPane({
  applyAdminLibraryChange,
  audibleManagement,
  audioRef,
  books,
  capabilities,
  carPlay,
  connectPromptDismissed,
  currentUser,
  demoMode,
  deviceImport,
  downloadedBookIds,
  error,
  finishFeedState,
  ipad,
  isLoading,
  isOffline,
  isOperaLibre,
  lastPurchaseSource,
  libraryOpen,
  librarySource,
  localMode,
  native,
  nativeTab,
  offlineDownloads,
  onConnectServer,
  openBookDetails,
  openNativeTab,
  pausePlayback,
  playbackBook,
  purchases,
  readerPreferences,
  refreshLibrary,
  resumeSelectedBook,
  selectBook,
  selectFromShelf,
  selectedBook,
  setBooks,
  setConnectPromptDismissed,
  setLibraryOpen,
  setLibrarySource,
  setUserMenuOpen,
  shelf,
  shelfPull,
  showYourLibrary,
  uploads,
  userMenu,
  userMenuOpen
}: {
  applyAdminLibraryChange: (nextBooks: Book[]) => void;
  audibleManagement: ReactNode;
  audioRef: RefObject<HTMLAudioElement | null>;
  books: Book[];
  capabilities: ServerCapabilities;
  carPlay: ReturnType<typeof useCarPlay>;
  connectPromptDismissed: boolean;
  currentUser: AuthUser;
  demoMode: boolean;
  deviceImport: { completed: number; total: number; } | null;
  downloadedBookIds: Set<string>;
  error: string | null;
  finishFeedState: ReturnType<typeof useFinishFeed>;
  ipad: boolean;
  isLoading: boolean;
  isOffline: boolean;
  isOperaLibre: boolean;
  lastPurchaseSource: RefObject<"audible" | "libro" | "all">;
  libraryOpen: boolean;
  librarySource: LibrarySource;
  localMode: boolean;
  native: boolean;
  nativeTab: NativeTab;
  offlineDownloads: ReturnType<typeof useOfflineDownloads>;
  onConnectServer: () => void;
  openBookDetails: (bookId: string) => void;
  openNativeTab: (tab: NativeTab) => void;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  playbackBook: Book | null;
  purchases: ReturnType<typeof usePurchases>;
  readerPreferences: ReturnType<typeof useReaderPreferences>;
  refreshLibrary: () => Promise<void>;
  resumeSelectedBook: (book: Book) => void;
  selectBook: (book: Book) => void;
  selectFromShelf: (book: Book) => void;
  selectedBook: Book;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setConnectPromptDismissed: Dispatch<SetStateAction<boolean>>;
  setLibraryOpen: Dispatch<SetStateAction<boolean>>;
  setLibrarySource: Dispatch<SetStateAction<LibrarySource>>;
  setUserMenuOpen: Dispatch<SetStateAction<boolean>>;
  shelf: ReturnType<typeof useShelf>;
  shelfPull: { pull: number; refreshing: boolean; handlers: { onTouchStart?: undefined; onTouchMove?: undefined; onTouchEnd?: undefined; onTouchCancel?: undefined; }; } | { pull: number; refreshing: boolean; handlers: { onTouchStart: (event: TouchEvent<HTMLElement>) => void; onTouchMove: (event: TouchEvent<HTMLElement>) => void; onTouchEnd: () => void; onTouchCancel: () => void; }; };
  showYourLibrary: () => void;
  uploads: ReturnType<typeof useUploads>;
  userMenu: ReactNode;
  userMenuOpen: boolean;
}) {
  const {
    activeShelfFilterChips,
    activeShelfFilterCount,
    changeShelfLayout,
    clearShelfFilters,
    closeShelfFilters,
    filterToggleRef,
    filtersOpen,
    purchaseViewMode,
    reverseSort,
    searchQuery,
    selectPurchaseViewMode,
    selectSortMode,
    selectViewMode,
    setFiltersOpen,
    setSearchQuery,
    setShelfFilters,
    shelfFacets,
    shelfFilters,
    shelfLayout,
    shelfSearchRef,
    showShelfFilters,
    sortMode,
    sortOrderLabel,
    sortReversed,
    viewMode,
    visibleBookColumns,
    visibleBooks
  } = shelf;
  const {
    allAudibleAccounts,
    audibleAccountFilter,
    audibleAccountLabels,
    brokenLibationAccounts,
    canBrowseLibation,
    displayedLibationJobs,
    downloadAllLibationJob,
    libationAllPending,
    libationBooks,
    libationBooksLoaded,
    libationDownloadRequests,
    libationError,
    libationFinalizationFailures,
    libationFinalizingAsins,
    libationJobs,
    libationLoading,
    libationMessage,
    libationRequests,
    libationStatus,
    libroAccounts,
    libroAvailable,
    libroOnDevice,
    libroRefreshKey,
    pendingLibationJobs,
    purchaseAccountFilter,
    setAudibleAccountFilter,
    setLibroAccounts,
    setPurchaseAccountFilter,
    showAudiblePurchases,
    startLiberation,
    visibleLibationBooks
  } = purchases;
  const {
    carPlaybackBook,
    takeOverFromCar
  } = carPlay;
  const {
    finishFeed,
    finishFeedAvailable,
    finishFeedOpen,
    setFinishFeedOpen,
    toggleFinishFeed
  } = finishFeedState;
  const {
    importFromDevice
  } = offlineDownloads;
  const {
    readalongEnabled
  } = readerPreferences;
  const {
    setUploadError,
    setUploadModalOpen
  } = uploads;

  return (
    <aside className={`library-pane ${libraryOpen ? "open" : ""} ${librarySource !== "local" ? "purchase-browsing" : ""}`} {...shelfPull.handlers}>
      {native ? (
        <div
          className={`pull-indicator ${shelfPull.refreshing ? "refreshing" : ""}`}
          style={
            shelfPull.refreshing
              ? undefined
              : {
                  opacity: Math.min(1, shelfPull.pull / PULL_REFRESH_THRESHOLD),
                  transform: `translateX(-50%) rotate(${Math.round(shelfPull.pull * 2.8)}deg)`
                }
          }
          aria-hidden="true"
        >
          <RefreshCcw size={17} strokeWidth={2} />
        </div>
      ) : null}
      <div className="pane-title">
        <div>
          <span className="eyebrow"><Library size={13} /> The Collection</span>
          <h1>OperaLibre</h1>
        </div>
        {native && ipad ? (
          <div className="shelf-layout-controls" role="group" aria-label="Shelf layout">
            {shelfLayout === "library" ? (
              <button
                type="button"
                className="icon-button"
                aria-label="Show the player beside the shelf"
                title="Show the player"
                onClick={() => {
                  haptic("light");
                  changeShelfLayout("split");
                }}
              >
                <Minimize2 size={16} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Hide the shelf"
                  title="Hide the shelf"
                  onClick={() => {
                    haptic("light");
                    changeShelfLayout("player");
                  }}
                >
                  <PanelLeftClose size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Expand the shelf to full screen"
                  title="Expand the shelf"
                  onClick={() => {
                    haptic("light");
                    changeShelfLayout("library");
                  }}
                >
                  <Maximize2 size={16} />
                </button>
              </>
            )}
          </div>
        ) : null}
        <div className="pane-actions">
          {native ? (
            <button
              className="icon-button"
              aria-label="Add audiobook from device"
              disabled={deviceImport !== null}
              onClick={() => void importFromDevice()}
            >
              {deviceImport ? <LoaderCircle size={16} className="spin-icon" /> : <FolderOpen size={16} />}
            </button>
          ) : null}
          {capabilities.uploads ? (
            <button
              className="icon-button"
              aria-label="Upload audiobook"
              onClick={() => {
                setUploadError(null);
                setUploadModalOpen(true);
              }}
            >
              <Upload size={16} />
            </button>
          ) : null}
          {finishFeedAvailable ? (
            <div className="finish-feed-wrap">
              <button
                className="icon-button finish-feed-button"
                aria-label={
                  finishFeed.unseenCount > 0
                    ? `Shared reading, ${finishFeed.unseenCount} new`
                    : "Shared reading"
                }
                aria-expanded={finishFeedOpen}
                onClick={toggleFinishFeed}
              >
                <Bell size={16} />
                {finishFeed.unseenCount > 0 ? (
                  <span className="finish-feed-badge" aria-hidden="true">
                    {finishFeed.unseenCount > 9 ? "9+" : finishFeed.unseenCount}
                  </span>
                ) : null}
              </button>
              {finishFeedOpen ? (
                <div className="finish-feed-panel" role="dialog" aria-label="Shared reading">
                  <header>
                    <strong>Shared reading</strong>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close shared reading"
                      onClick={() => setFinishFeedOpen(false)}
                    >
                      <X size={14} />
                    </button>
                  </header>
                  {finishFeed.entries.length === 0 ? (
                    <p className="finish-feed-empty">
                      Nobody has finished a book yet. When someone does, it shows up here.
                    </p>
                  ) : (
                    <ul>
                      {finishFeed.entries.map((entry) => (
                        <li key={entry.id} className={entry.unseen ? "unseen" : ""}>
                          <button
                            type="button"
                            onClick={() => {
                              const book = books.find((candidate) => candidate.id === entry.bookId);
                              if (book) {
                                selectBook(book);
                                setLibraryOpen(false);
                              }
                              setFinishFeedOpen(false);
                            }}
                          >
                            <span className="finish-feed-text">{finishAnnouncement(entry)}</span>
                            <span className="finish-feed-when">
                              {finishedAgoLabel(entry.finishedAt)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            className="icon-button"
            aria-label={capabilities.administration ? "Rescan library" : "Refresh library"}
            onClick={() => void refreshLibrary()}
          >
            <RefreshCcw size={16} />
          </button>
          <div className="user-menu-wrap">
            <button
              className="icon-button"
              aria-label="Account menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              <span className="user-avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
            </button>
            {userMenuOpen
              ? native
                ? createPortal(
                    <div className="user-menu-layer">
                      <button
                        type="button"
                        className="user-menu-scrim"
                        aria-label="Close menu"
                        onClick={() => setUserMenuOpen(false)}
                      />
                      {userMenu}
                    </div>,
                    document.body
                  )
                : userMenu
              : null}
          </div>
          <button
            className="icon-button library-close"
            aria-label="Close library"
            onClick={() => setLibraryOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="library-toolbar">
        {!demoMode && libroAvailable ? (
          <>
            <div className="source-toggle shelf-navigation" role="group" aria-label="Library navigation">
              <button type="button" className={librarySource === "local" ? "selected" : ""} onClick={showYourLibrary} aria-pressed={librarySource === "local"}>
                <Library size={16} /> Library
              </button>
              <button type="button" className={librarySource !== "local" ? "selected" : ""} onClick={() => setLibrarySource(lastPurchaseSource.current === "audible" && !canBrowseLibation ? "libro" : lastPurchaseSource.current)} aria-pressed={librarySource !== "local"}>
                <Cloud size={16} /> Get books
                {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} Audible accounts need attention`}>{brokenLibationAccounts.length}</span> : null}
              </button>
            </div>
            {librarySource !== "local" ? (
              <>
              <div className="purchase-source">
                <div className="purchase-tabs" role="tablist" aria-label="Book stores">
                  {(["all", "libro", ...(canBrowseLibation ? ["audible"] : [])] as LibrarySource[]).map(source => (
                    <button key={source} id={`purchase-tab-${source}`} type="button" role="tab"
                      aria-selected={librarySource === source} aria-controls="purchase-results"
                      tabIndex={librarySource === source ? 0 : -1}
                      onClick={() => { setAudibleAccountFilter("all"); setPurchaseAccountFilter("all"); setLibrarySource(source); }}
                      onKeyDown={event => {
                        const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                        const index = tabs.indexOf(event.currentTarget);
                        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                          : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
                        if (next < 0) return;
                        event.preventDefault();
                        tabs[next].focus();
                        tabs[next].click();
                      }}>
                      {source === "all" ? "All accounts" : source === "libro" ? "Libro.fm" : "Audible"}
                      {source === "audible" && brokenLibationAccounts.length > 0 ? <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} accounts need attention`}>{brokenLibationAccounts.length}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            </>
            ) : null}
          </>
        ) : null}
        <div className="library-search-row">
          <div className="library-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              ref={shelfSearchRef}
              placeholder={librarySource === "local" ? "Search books, authors, tags…" : librarySource === "libro" ? "Search Libro.fm purchases…" : librarySource === "all" ? "Search all purchases…" : "Search Audible titles…"}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              aria-label="Search library"
            />
            {searchQuery ? (
              <button
                type="button"
                className="library-search-clear"
                aria-label="Clear search"
                onClick={() => { setSearchQuery(""); shelfSearchRef.current?.focus(); }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {showShelfFilters ? (
            <button
              type="button"
              ref={filterToggleRef}
              className={`library-filter-toggle ${filtersOpen ? "open" : ""} ${activeShelfFilterCount > 0 ? "engaged" : ""}`}
              onClick={() => setFiltersOpen(!filtersOpen)}
              aria-expanded={filtersOpen}
              aria-controls="library-filter-panel"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>Filters</span>
              {activeShelfFilterCount > 0 ? <em>{activeShelfFilterCount}</em> : null}
            </button>
          ) : null}
        </div>

        <div className="library-controls">
          <label className="library-sort">
            <span>Sort by</span>
            <select
              value={sortMode}
              onChange={(event) => selectSortMode(event.currentTarget.value as SortMode)}
              aria-label="Sort library by"
            >
              {SORT_OPTIONS.filter((option) => isSortModeSupported(librarySource, option.value)).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="library-sort-direction"
            onClick={reverseSort}
            aria-label={`Reverse sort order (currently ${sortOrderLabel})`}
            title={`Reverse sort order · ${sortOrderLabel}`}
            aria-pressed={sortReversed}
          >
            {sortReversed ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
          </button>
          <div className="view-toggle" role="group" aria-label={librarySource === "local" ? "View mode" : "Purchase view mode"}>
            {SHELF_VIEW_MODE_OPTIONS.map((option) => {
              const Icon = option.value === "list" ? List : option.value === "compact" ? Rows3 : LayoutGrid;
              const activeViewMode = librarySource === "local" ? viewMode : purchaseViewMode;
              return (
                <button
                  type="button"
                  key={option.value}
                  className={activeViewMode === option.value ? "selected" : ""}
                  onClick={() => librarySource === "local" ? selectViewMode(option.value) : selectPurchaseViewMode(option.value)}
                  aria-label={option.label}
                  title={option.value === "compact" ? "Compact view · more books per screen" : option.label}
                  aria-pressed={activeViewMode === option.value}
                >
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
        </div>

        {showShelfFilters && filtersOpen ? (
          <section
            className="library-filters"
            id="library-filter-panel"
            aria-label="Library filters"
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); closeShelfFilters(); }
            }}
          >
            <div className="library-filters-heading">
              <strong>Find your next listen</strong>
              <button type="button" className="library-clear-filters" onClick={closeShelfFilters}>Done</button>
            </div>
            <div className="library-filters-body">
              <div className="shelf-facet shelf-facet-status">
                <div className="shelf-facet-heading">
                  <span className="shelf-facet-title">Progress</span>
                </div>
                <div className="shelf-status-row" role="group" aria-label="Filter by reading progress">
                  {SHELF_STATUS_OPTIONS.map((option) => {
                    const isSelected = shelfFilters.status === option.value;
                    const count = shelfFacets.statusCounts[option.value];
                    return (
                      <button
                        type="button"
                        key={option.value}
                        className={isSelected ? "selected" : ""}
                        aria-pressed={isSelected}
                        disabled={count === 0 && !isSelected}
                        onClick={() => setShelfFilters({ ...shelfFilters, status: option.value })}
                      >
                        <span>{option.label}</span>
                        <em>{count}</em>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="shelf-facet shelf-facet-availability">
                <div className="shelf-facet-heading">
                  <span className="shelf-facet-title">Availability</span>
                </div>
                <div className="shelf-facet-chips" role="group" aria-label="Filter by availability">
                  <button
                    type="button"
                    className={`facet-chip ${shelfFilters.downloadedOnly ? "selected" : ""}`}
                    aria-pressed={shelfFilters.downloadedOnly}
                    disabled={shelfFacets.downloadedCount === 0 && !shelfFilters.downloadedOnly}
                    onClick={() => setShelfFilters({
                      ...shelfFilters,
                      downloadedOnly: !shelfFilters.downloadedOnly
                    })}
                  >
                    <span className="facet-chip-label">Downloaded on Device</span>
                    <em>{shelfFacets.downloadedCount}</em>
                  </button>
                </div>
              </div>

              <div className="shelf-facet-groups">
                <ShelfFacetGroup
                  title="Genres"
                  hint="No genres on this shelf yet. Add them when you edit a book’s details."
                  options={shelfFacets.genres}
                  selected={shelfFilters.genres}
                  onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "genres", key))}
                />
                <ShelfFacetGroup
                  title="Tags"
                  hint="No tags on this shelf yet. Tag books to gather a wider world or reading order."
                  options={shelfFacets.tags}
                  selected={shelfFilters.tags}
                  onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "tags", key))}
                />
              </div>
              <p className="shelf-facet-hint">Choose any in each group. Combine groups to narrow your shelf.</p>
            </div>
          </section>
        ) : null}

        {showShelfFilters && activeShelfFilterCount > 0 ? (
          <div className="library-active-filters">
            <span className="library-active-filters-caption">Filtering</span>
            {activeShelfFilterChips.map((chip) => (
              <button
                type="button"
                key={chip.id}
                className="active-filter-chip"
                onClick={chip.clear}
                aria-label={`Remove ${chip.caption.toLowerCase()} filter ${chip.label}`}
              >
                <span className="active-filter-caption">{chip.caption}</span>
                <span className="active-filter-label">{chip.label}</span>
                <X size={11} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
              Clear all
            </button>
          </div>
        ) : null}

        {librarySource !== "libro" && librarySource !== "all" ? <div className="library-results-summary" role="status" aria-live="polite" aria-atomic="true">
          <span>
            {librarySource === "local"
              ? isLoading ? "Loading books…" : `${visibleBooks.length} of ${books.length} books`
              : libationLoading ? "Loading books…" : `${visibleLibationBooks.length} of ${libationBooks.length} books`}
          </span>
          <span>{sortOrderLabel}</span>
        </div> : null}

      </div>

      {carPlaybackBook ? (
        <section className="carplay-banner">
          <div className="carplay-banner-copy">
            <strong>Audiobook playing</strong>
            <span>{carPlaybackBook.title}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              takeOverFromCar();
              resumeSelectedBook(carPlaybackBook);
            }}
          >
            Open player
          </button>
        </section>
      ) : null}

      <div id="purchase-results" className="purchase-results" role={librarySource !== "local" ? "tabpanel" : undefined} aria-labelledby={librarySource !== "local" ? `purchase-tab-${librarySource}` : undefined}>
      <div className="purchase-settings-pane">
      {!native && showAudiblePurchases && canBrowseLibation ? (
        <details className="purchase-console">
          <summary><span>Audible accounts &amp; downloads</span><ChevronDown size={15} /></summary>
          {audibleManagement}
        </details>
      ) : null}
      {librarySource === "all" ? <label className="purchase-account-filter">
        <span className="purchase-control-label">Account</span>
        <select aria-label="Purchase account" value={purchaseAccountFilter} onChange={event => setPurchaseAccountFilter(event.target.value)}>
          <option value="all">All accounts</option>
          {canBrowseLibation && allAudibleAccounts.length > 0 ? <optgroup label="Audible">{allAudibleAccounts.map(account => <option key={account.id} value={`audible:${account.id}`}>Audible · {account.name}</option>)}</optgroup> : null}
          {(libroAccounts?.length ?? 0) > 0 ? <optgroup label="Libro.fm">{libroAccounts!.map(account => <option key={account.email} value={`libro:${account.email}`}>Libro.fm · {account.nickname || account.email}</option>)}</optgroup> : null}
        </select>
      </label> : null}
      {librarySource === "audible" && allAudibleAccounts.length > 1 ? <label className="purchase-account-filter">
        <span className="purchase-control-label">Account</span>
        <select aria-label="Audible account" value={audibleAccountFilter} onChange={event => setAudibleAccountFilter(event.currentTarget.value)}>
          <option value="all">All Audible accounts</option>
          {allAudibleAccounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
      </label> : null}
      {showAudiblePurchases && (displayedLibationJobs.length > 0 || libationMessage || brokenLibationAccounts.length > 0) ? (
        <details className="purchase-console">
          <summary>
            <span><CloudDownload size={14} /> Activity</span>
            <strong>{displayedLibationJobs.some(isPendingJob) ? "Working" : brokenLibationAccounts.length > 0 ? "Needs attention" : "Up to date"}</strong>
            <ChevronDown size={15} />
          </summary>
          <div className="purchase-console-body">
            {libationMessage ? <p role="status">{libationMessage}</p> : null}
            {native && brokenLibationAccounts.length > 0 ? <button type="button" className="purchase-settings-link" onClick={() => openNativeTab("settings")}>
              <AlertCircle size={14} /> {brokenLibationAccounts.length} Audible account{brokenLibationAccounts.length === 1 ? " needs" : "s need"} attention <ChevronRight size={14} />
            </button> : null}
            {displayedLibationJobs.map((job) => {
            const targetTitle = job.targetId
              ? libationBooks.find((book) => book.catalogId === job.targetId)?.title
              : null;
            return (
            <details key={job.id} className={`job-card audible-job ${job.status}`}>
              <summary className="job-card-head">
                <span className="job-state">
                  {job.status === "queued" ? (
                    <List size={13} />
                  ) : job.status === "running" ? (
                    <LoaderCircle size={13} className="spin-icon" />
                  ) : job.status === "failed" ? (
                    <AlertCircle size={13} />
                  ) : (
                    <CloudDownload size={13} />
                  )}
                  {jobStateLabel(job)}
                </span>
                <strong>{targetTitle ?? (job.kind === "libation-sync" && job.status === "completed" ? "Library refreshed" : jobTitle(job))}</strong>
                <ChevronDown size={15} />
              </summary>
              <p>{jobSummary(job)}</p>
              <dl className="job-meta">
                <div>
                  <dt>Elapsed</dt>
                  <dd>{formatElapsed(job.startedAt, job.finishedAt) ?? "Starting"}</dd>
                </div>
                {job.exitCode !== null ? (
                  <div>
                    <dt>Exit</dt>
                    <dd>{job.exitCode}</dd>
                  </div>
                ) : null}
              </dl>
              {!isPendingJob(job) || job.error ? (
                <pre className="job-output">{jobDetailLines(job).join("\n")}</pre>
              ) : null}
            </details>
            );
            })}
          </div>
        </details>
      ) : null}

      </div>
      <div className="purchase-books-pane">

      {librarySource === "libro" || librarySource === "all" ? (
        <LibroCatalog key={`${currentUser.id}:${libroOnDevice ? "device" : "server"}`} mode={native ? "catalog" : "full"} polling={!native || nativeTab === "shelf"} onOpenSettings={native ? () => openNativeTab("settings") : undefined} onAccountsChanged={setLibroAccounts} filterEmail={librarySource === "all" ? (purchaseAccountFilter.startsWith("libro:") ? purchaseAccountFilter.slice(6) : null) : undefined} hidden={librarySource === "all" && purchaseAccountFilter.startsWith("audible:")} device={libroOnDevice} refreshKey={libroRefreshKey} searchQuery={searchQuery} sortMode={sortMode} reversed={sortReversed} viewMode={purchaseViewMode} onBooksChanged={libroOnDevice ? () => setBooks(current => mergeDeviceAndServerBooks(current.filter(book => book.source !== "device"), getDeviceBooks())) : applyAdminLibraryChange} onOpenBook={(id) => { showYourLibrary(); openBookDetails(id); }} />
      ) : null}

      {librarySource === "local" ? (
        <>
          {localMode && !connectPromptDismissed && !hasUserConfiguredServer() ? (
            <section className="connect-server-card" aria-label="Connect a server">
              <span className="section-label"><Network size={13} /> Listening from this device</span>
              <p>
                Everything here stays on this device — no server or account needed.
                When your OperaLibre or Jellyfin server is ready, connect it to
                stream a shared library and sync your progress.
              </p>
              <a
                className="connect-server-guide"
                href={SERVER_SETUP_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} aria-hidden="true" />
                <span>New to OperaLibre? Read the server setup guide</span>
              </a>
              <div className="connect-server-actions">
                <button
                  type="button"
                  className="download-btn"
                  onClick={() => {
                    pausePlayback(audioRef.current);
                    onConnectServer();
                  }}
                >
                  <Network size={13} />
                  <span>Connect a server</span>
                </button>
                <button
                  type="button"
                  className="connect-server-dismiss"
                  onClick={() => {
                    writeStoredValue(CONNECT_PROMPT_DISMISSED_KEY, "true");
                    setConnectPromptDismissed(true);
                  }}
                >
                  Maybe later
                </button>
              </div>
            </section>
          ) : null}
          {isLoading ? <div className="empty-state">Loading library…</div> : null}
          {error ? <div className="empty-state error">{error}</div> : null}
          {!isLoading && !error && books.length === 0 ? (
            <div className="empty-state device-empty-state">
              <span>{localMode ? "Your shelf is ready. Pick audiobook files from this device to start listening." : !isOperaLibre ? "No audiobooks are available to this account. Add audiobooks to a Books library in Jellyfin and check this account’s library access. Music libraries are not included." : "No audiobooks found in the configured library folder."}</span>
              {native ? (
                <button type="button" className="download-btn" onClick={() => void importFromDevice()}>
                  <FolderOpen size={14} /> Choose audiobook files
                </button>
              ) : null}
            </div>
          ) : null}
          {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
            <div className="empty-state shelf-empty-state">
              <span>
                {searchQuery.trim()
                  ? `Nothing matches “${searchQuery.trim()}”${activeShelfFilterCount > 0 ? " under these filters" : ""}.`
                  : "No books match these filters."}
              </span>
              {activeShelfFilterCount > 0 ? (
                <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
                  Clear filters
                </button>
              ) : null}
              {searchQuery ? (
                <button type="button" className="library-clear-filters" onClick={() => setSearchQuery("")}>
                  Clear search
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Compact keeps the list layout and only tightens it, so it carries
              both classes rather than forking every row rule. */}
          <ShelfBookList
            columns={visibleBookColumns}
            viewMode={viewMode}
            sortMode={sortMode}
            shelfTags={shelfFilters.tags}
            selectedBookId={selectedBook?.id ?? null}
            playbackBookId={playbackBook?.id ?? null}
            downloadedBookIds={downloadedBookIds}
            isOffline={isOffline}
            demoMode={demoMode}
            localMode={localMode}
            native={native}
            readalongEnabled={readalongEnabled}
            onSelectBook={selectFromShelf}
          />
        </>
      ) : showAudiblePurchases ? (
        <>
          {librarySource === "all" ? <h2 className="purchase-provider-heading">Audible</h2> : null}
          {libationLoading || (libationStatus?.enabled && !libationBooksLoaded) ? (
            <div className="empty-state">Loading Audible library…</div>
          ) : null}
          {libationError ? <div className="empty-state error">{libationError}</div> : null}
          {!libationLoading && !libationError && libationBooksLoaded && libationStatus?.enabled && visibleLibationBooks.length === 0 ? (
            <div className="empty-state">No Libation books loaded yet.</div>
          ) : null}

          <div className={`audible-list purchase-book-list purchase-book-list--${purchaseViewMode} audible-list--${purchaseViewMode}`}>
            {visibleLibationBooks.map((book) => {
              const isLocal = !!book.localBookId;
              const downloadRequest = libationDownloadRequests.find(
                (request) => (request.catalogId ? request.catalogId === book.catalogId : request.profileId ? `${request.profileId}:${request.asin}` === book.catalogId : request.asin === book.asin) && request.status !== "rejected"
              );
              const isAwaitingApproval = downloadRequest?.status === "pending";
              const isApprovedRequest = downloadRequest?.status === "approved" && !!downloadRequest.jobId;
              const pendingDownloadJob =
                pendingLibationJobs.find(
                  (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
                ) ?? downloadAllLibationJob;
              const latestBookJob = libationJobs.find(
                (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
              );
              const isStarting = libationAllPending || libationRequests.has(book.catalogId);
              const isQueued = pendingDownloadJob?.status === "queued";
              const isDownloading = pendingDownloadJob?.status === "running";
              const finalizationFailed = libationFinalizationFailures.has(book.catalogId);
              const isFinalizing = isLibationAdding({
                isLocal,
                confirmationPending: libationFinalizingAsins.has(book.catalogId),
                confirmationFailed: finalizationFailed
              });
              const didFail = latestBookJob?.status === "failed" || finalizationFailed;
              const metaParts = [
                book.authors,
                formatMinutes(book.lengthMinutes),
                isLocal ? "In library" : book.bookStatus
              ].filter(Boolean);
              return (
                <div key={book.catalogId} className={`audible-row purchase-book-row ${isLocal ? "is-local" : ""}`}>
                  <LibationCoverArt book={book} />
                  <div className="audible-copy">
                    <strong>{book.title}</strong>
                    <span>{metaParts.join(" · ")}</span>
                    <small className="audible-account-badge"><span className="purchase-provider-tag">Audible</span><KeyRound size={10} /> {audibleAccountLabels.get(book.profileId) ?? book.profileName}</small>
                  </div>
                  {isLocal ? (
                    <button
                      type="button"
                      className="local-marker"
                      aria-label={`Open ${book.title} from your library`}
                      onClick={() => {
                        if (!book.localBookId) {
                          return;
                        }
                        openBookDetails(book.localBookId);
                        setLibrarySource("local");
                        setLibraryOpen(false);
                      }}
                    >
                      <CircleCheck size={14} />
                      <span>In library</span>
                    </button>
                  ) : isAwaitingApproval ? (
                    <span className="audible-download-status queued" role="status" aria-label={`Requested ${book.title}`}>
                      <List size={14} />
                      <span>Requested</span>
                    </span>
                  ) : isStarting || isQueued || isDownloading || isFinalizing || (isApprovedRequest && !finalizationFailed) ? (
                    <span
                      className={`audible-download-status ${
                        isQueued ? "queued" : isDownloading ? "downloading" : isFinalizing || isApprovedRequest ? "finalizing" : "starting"
                      }`}
                      role="status"
                      aria-label={`${
                        isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding to library" : "Starting download"
                      } ${book.title}`}
                    >
                      {isQueued ? <List size={14} /> : <LoaderCircle size={14} className="spin-icon" />}
                      <span>{isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding" : "Starting"}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`audible-download-action ${didFail ? "retry" : ""}`}
                      aria-label={`${didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"} ${book.title}`}
                      onClick={() => void startLiberation(book)}
                    >
                      <CloudDownload size={14} />
                      <span>{didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"}</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      </div>
      </div>
    </aside>
  );
}
