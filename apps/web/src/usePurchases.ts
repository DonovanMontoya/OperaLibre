import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supportsLibroDevice } from "./libroDevice";
import type {
  AuthUser,
  JobStatus,
  LibationBook,
  LibationDownloadRequest,
  LibationStatus,
  LibroAccountSummary
} from "./types";
import { errorMessage, formatLibationMessage } from "./formatting";
import { isPendingJob, jobSummary, reconcileLibationJobs } from "./jobLabels";
import {
  getJob,
  getLibationAccess,
  getLibationBooks,
  getLibationStatus,
  getMe,
  liberateAllLibationBooks,
  liberateLibationBook,
  listJobs,
  listLibationRequests,
  requestLibationBook,
  syncLibationLibrary
} from "./api";
import type { ServerCapabilities } from "./serverCapabilities";
import type { LibrarySource, SortMode } from "./shelfSort";

const LIBATION_CONFIRM_TIMEOUT_MS = 12_000;
const LIBATION_READER_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

export function usePurchases({
  capabilities,
  currentUser,
  demoMode,
  isOperaLibre,
  libationBooks,
  libationBooksLoaded,
  librarySource,
  loadBooks,
  localMode,
  native,
  onCurrentUserChanged,
  searchQuery,
  setLibationBooks,
  setLibationBooksLoaded,
  sortMode,
  sortReversed
}: {
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  isOperaLibre: boolean;
  libationBooks: LibationBook[];
  libationBooksLoaded: boolean;
  librarySource: LibrarySource;
  loadBooks: () => Promise<void>;
  localMode: boolean;
  native: boolean;
  onCurrentUserChanged: (user: AuthUser) => void;
  searchQuery: string;
  setLibationBooks: Dispatch<SetStateAction<LibationBook[]>>;
  setLibationBooksLoaded: Dispatch<SetStateAction<boolean>>;
  sortMode: SortMode;
  sortReversed: boolean;
}) {
  const [libroRefreshKey, setLibroRefreshKey] = useState(0);
  const [libroDestination, setLibroDestination] = useState<"server" | "device">("server");
  const libroOnDevice = localMode || !isOperaLibre || libroDestination === "device";
  const libroAvailable = (!localMode && isOperaLibre) || supportsLibroDevice();
  const [libationStatus, setLibationStatus] = useState<LibationStatus | null>(null);
  const [libationDownloadRequests, setLibationDownloadRequests] = useState<LibationDownloadRequest[]>([]);
  const libationDownloadRequestsRef = useRef<LibationDownloadRequest[]>([]);
  const libationRequestsLoadedRef = useRef(false);
  const [libationLoading, setLibationLoading] = useState(false);
  const [libationError, setLibationError] = useState<string | null>(null);
  const [libationRequests, setLibationRequests] = useState<Set<string>>(new Set());
  const [libationAllPending, setLibationAllPending] = useState(false);
  const [libationJobs, setLibationJobs] = useState<JobStatus[]>([]);
  const libationJobsRef = useRef<JobStatus[]>([]);
  const libationJobsGenerationRef = useRef(0);
  const [libationFinalizingAsins, setLibationFinalizingAsins] = useState<Set<string>>(new Set());
  const [libationFinalizationFailures, setLibationFinalizationFailures] = useState<Set<string>>(new Set());
  const libationFinalizationStartedRef = useRef<Map<string, number>>(new Map());
  const [libationRefreshPending, setLibationRefreshPending] = useState(false);
  const [purchaseAccountFilter, setPurchaseAccountFilter] = useState("all");
  const [libroAccounts, setLibroAccounts] = useState<LibroAccountSummary[] | null>(null);
  useEffect(() => { setPurchaseAccountFilter("all"); setLibroAccounts(null); }, [libroOnDevice, currentUser.id]);
  const [audibleAccountFilter, setAudibleAccountFilter] = useState("all");
  const libationMessage = formatLibationMessage(libationStatus);
  const brokenLibationAccounts = libationStatus?.accounts.filter((account) => !account.authenticated) ?? [];
  const pendingLibationJobs = libationJobs.filter(isPendingJob);
  const displayedLibationJobs = pendingLibationJobs.length > 0 ? pendingLibationJobs : libationJobs.slice(0, 1);
  const refreshLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-sync");
  const downloadAllLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-liberate-all");
  const isRefreshingAudible = libationRefreshPending || !!refreshLibationJob;
  const canBrowseLibation = capabilities.imports && (currentUser.isAdmin || (native && !!libationStatus?.enabled));
  const showAudiblePurchases = librarySource === "audible" || (librarySource === "all" && canBrowseLibation && !purchaseAccountFilter.startsWith("libro:"));

  const audibleAccountLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const account of libationStatus?.accounts ?? []) {
      if (account.name?.trim()) labels.set(account.id, account.name.trim());
    }
    for (const book of libationBooks) {
      if (!labels.has(book.profileId)) labels.set(book.profileId, book.profileName);
    }
    return labels;
  }, [libationBooks, libationStatus?.accounts]);

  const visibleLibationBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const selectedAccount = librarySource === "all" ? (purchaseAccountFilter.startsWith("audible:") ? purchaseAccountFilter.slice(8) : "all") : audibleAccountFilter;
    const accountBooks = selectedAccount === "all"
      ? libationBooks
      : libationBooks.filter((book) => book.profileId === selectedAccount);
    const filtered = query
      ? accountBooks.filter((book) =>
          [book.title, book.subtitle, book.authors, book.narrators]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : accountBooks;

    const sorted = [...filtered].sort((a, b) => {
      if (sortMode === "account") {
        const aLabel = audibleAccountLabels.get(a.profileId) ?? a.profileName;
        const bLabel = audibleAccountLabels.get(b.profileId) ?? b.profileName;
        return aLabel.localeCompare(bLabel) || a.title.localeCompare(b.title);
      }
      if (sortMode === "author") {
        return (a.authors ?? "").localeCompare(b.authors ?? "") || a.title.localeCompare(b.title);
      }
      if (sortMode === "duration") {
        return (b.lengthMinutes ?? 0) - (a.lengthMinutes ?? 0);
      }
      return a.title.localeCompare(b.title);
    });
    return sortReversed ? sorted.reverse() : sorted;
  }, [audibleAccountFilter, audibleAccountLabels, libationBooks, searchQuery, sortMode, sortReversed, librarySource, purchaseAccountFilter]);
  const audibleProfiles = useMemo(() => {
    const profiles = new Map<string, string>();
    for (const book of libationBooks) {
      profiles.set(book.profileId, audibleAccountLabels.get(book.profileId) ?? book.profileName);
    }
    return [...profiles].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [audibleAccountLabels, libationBooks]);

  const allAudibleAccounts = useMemo(() => {
    const accounts = new Map(audibleProfiles.map(account => [account.id, account.name]));
    for (const account of libationStatus?.accounts ?? []) accounts.set(account.id, account.name || account.accountId);
    return [...accounts].map(([id, name]) => ({ id, name }));
  }, [audibleProfiles, libationStatus]);
  useEffect(() => {
    if (purchaseAccountFilter.startsWith("libro:") && libroAccounts && !libroAccounts.some(account => `libro:${account.email}` === purchaseAccountFilter)) setPurchaseAccountFilter("all");
    if (purchaseAccountFilter.startsWith("audible:") && libationStatus && !allAudibleAccounts.some(account => `audible:${account.id}` === purchaseAccountFilter)) setPurchaseAccountFilter("all");
  }, [purchaseAccountFilter, libroAccounts, libationStatus, allAudibleAccounts]);

  // Accounts come and go in Libation, so a filter pinned to a departed account
  // would quietly show an empty library under a select that reads "All accounts".
  useEffect(() => {
    if (audibleAccountFilter === "all") return;
    const known = (libationStatus?.accounts ?? []).some((account) => account.id === audibleAccountFilter)
      || audibleProfiles.some((profile) => profile.id === audibleAccountFilter);
    if (!known && (libationStatus || audibleProfiles.length > 0)) {
      setAudibleAccountFilter("all");
    }
  }, [audibleAccountFilter, audibleProfiles, libationStatus]);

  const loadLibationStatus = useCallback(async () => {
    if (!isOperaLibre || (!currentUser.isAdmin && !native)) {
      setLibationStatus(null);
      return;
    }
    try {
      if (currentUser.isAdmin) {
        setLibationStatus(await getLibationStatus());
      } else {
        const access = await getLibationAccess();
        setLibationStatus({
          enabled: access.enabled,
          cliPath: null,
          libationFilesDir: null,
          libraryRoot: "",
          accounts: [],
          authenticated: access.enabled,
          message: access.enabled ? null : "Libation is not configured on this server.",
          autoRefreshHours: access.autoRefreshHours,
          manualRefreshesPerHour: access.manualRefreshesPerHour
        });
      }
    } catch {
      setLibationStatus(null);
    }
  }, [currentUser.isAdmin, isOperaLibre, native]);

  const loadLibationBooks = useCallback(async (clearError = true) => {
    setLibationLoading(true);
    if (clearError) {
      setLibationError(null);
    }
    try {
      const nextBooks = await getLibationBooks();
      setLibationBooks(nextBooks);
      const confirmedAsins = new Set(nextBooks.filter((book) => !!book.localBookId).map((book) => book.catalogId));
      setLibationFinalizingAsins((current) => {
        const next = new Set([...current].filter((asin) => !confirmedAsins.has(asin)));
        return next.size === current.size ? current : next;
      });
      setLibationBooksLoaded(true);
      await loadLibationStatus();
    } catch {
      setLibationError("Libation books could not be loaded.");
      setLibationBooksLoaded(true);
    } finally {
      setLibationLoading(false);
    }
  }, [loadLibationStatus, setLibationBooks, setLibationBooksLoaded]);

  useEffect(() => {
    if (currentUser.isAdmin || native) {
      void loadLibationStatus();
    }
  }, [currentUser.isAdmin, loadLibationStatus, native]);

  useEffect(() => {
    if (!currentUser.isAdmin || !isOperaLibre) {
      return;
    }
    const timer = window.setInterval(() => void loadLibationStatus(), 60_000);
    return () => window.clearInterval(timer);
  }, [currentUser.isAdmin, isOperaLibre, loadLibationStatus]);

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }
    let cancelled = false;
    const generation = libationJobsGenerationRef.current;
    void listJobs()
      .then((jobs) => {
        if (cancelled || generation !== libationJobsGenerationRef.current) {
          return;
        }
        const next = reconcileLibationJobs(jobs, libationJobsRef.current);
        libationJobsRef.current = next;
        setLibationJobs(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUser.isAdmin]);

  useEffect(() => {
    if ((librarySource === "audible" || librarySource === "all") && libationStatus?.enabled && !libationBooksLoaded && !libationLoading) {
      void loadLibationBooks();
    }
  }, [libationBooksLoaded, libationLoading, libationStatus?.enabled, librarySource, loadLibationBooks]);

  useEffect(() => {
    if (
      (librarySource !== "audible" && librarySource !== "all") ||
      currentUser.libationAccess !== "approval"
    ) {
      return;
    }
    let cancelled = false;
    const refreshRequests = () => {
      void listLibationRequests()
        .then((requests) => {
          if (cancelled) return;
          const ownRequests = requests.filter((request) => request.userId === currentUser.id);
          const prior = libationDownloadRequestsRef.current;
          const newlyCompletedAsins = libationRequestsLoadedRef.current
            ? ownRequests
                .filter(
                  (request) =>
                    request.status === "completed" &&
                    prior.find((item) => item.id === request.id)?.status !== "completed"
                )
                .map((request) => request.catalogId ?? (request.profileId ? `${request.profileId}:${request.asin}` : libationBooks.find((book) => book.asin === request.asin)?.catalogId ?? `legacy:${request.asin}`))
            : [];
          libationDownloadRequestsRef.current = ownRequests;
          libationRequestsLoadedRef.current = true;
          setLibationDownloadRequests(ownRequests);
          const approvedAsins = ownRequests
            .filter((request) => request.status === "approved" && request.jobId)
            .map((request) => request.catalogId ?? (request.profileId ? `${request.profileId}:${request.asin}` : libationBooks.find((book) => book.asin === request.asin)?.catalogId ?? `legacy:${request.asin}`));
          const activeAsins = [...approvedAsins, ...newlyCompletedAsins];
          if (activeAsins.length > 0) {
            setLibationFinalizingAsins((current) => new Set([...current, ...activeAsins]));
          }
        })
        .catch(() => undefined);
    };
    // Poll quickly only while a request is still moving (awaiting a decision
    // or approved and downloading); otherwise a slow check still notices a
    // new decision. A hidden page polls not at all and catches up on return.
    let lastRefreshAt = 0;
    const tick = (force = false) => {
      if (document.visibilityState === "hidden") return;
      const moving = libationDownloadRequestsRef.current.some(
        (request) => request.status === "pending" || request.status === "approved"
      );
      const now = Date.now();
      if (!force && !moving && now - lastRefreshAt < 60_000) return;
      lastRefreshAt = now;
      refreshRequests();
    };
    const onVisible = () => tick(true);
    tick(true);
    const timer = window.setInterval(() => tick(), 5000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [currentUser.id, currentUser.libationAccess, libationBooks, librarySource]);

  // Keyed on whether anything is pending, not on the job list itself: each
  // poll replaces the list, which would otherwise rebuild the timer on every
  // tick. The callback reads jobs and books through refs so it stays current.
  const libationJobsPending = libationJobs.some(isPendingJob);
  const libationBooksRef = useRef(libationBooks);
  useEffect(() => {
    if (!libationJobsPending) {
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      const generation = libationJobsGenerationRef.current;
      const previous = libationJobsRef.current;
      const jobsRequest = currentUser.isAdmin
        ? listJobs()
        : Promise.all(previous.filter(isPendingJob).map((job) => getJob(job.id))).then((updates) => {
            const updatesById = new Map(updates.map((job) => [job.id, job]));
            return previous.map((job) => updatesById.get(job.id) ?? job);
          });
      void jobsRequest
        .then((jobs) => {
          if (cancelled || generation !== libationJobsGenerationRef.current) {
            return;
          }
          const next = reconcileLibationJobs(jobs, previous);
          const nextById = new Map(next.map((job) => [job.id, job]));
          const finishedJobs = previous
            .map((job) => nextById.get(job.id))
            .filter((current): current is JobStatus => !!current)
            .filter((current) => {
              const prior = previous.find((job) => job.id === current.id);
              return !!prior && isPendingJob(prior) && !isPendingJob(current);
            });
          libationJobsRef.current = next;
          setLibationJobs(next);
          if (finishedJobs.length > 0) {
            const completedAsins = finishedJobs.flatMap((job) => {
              if (job.status !== "completed") {
                return [];
              }
              if (job.kind === "libation-liberate" && job.targetId) {
                return [job.targetId];
              }
              if (job.kind === "libation-liberate-all") {
                return libationBooksRef.current.filter((book) => !book.localBookId).map((book) => book.catalogId);
              }
              return [];
            });
            if (completedAsins.length > 0) {
              const now = Date.now();
              for (const asin of completedAsins) {
                libationFinalizationStartedRef.current.set(asin, now);
              }
              setLibationFinalizingAsins((current) => new Set([...current, ...completedAsins]));
            }
            void loadBooks();
            if (!next.some(isPendingJob)) {
              void loadLibationBooks(false);
            }
            const failedJob = finishedJobs.find((job) => job.status === "failed");
            if (failedJob) {
              setLibationError(jobSummary(failedJob));
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false;
        });
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUser.isAdmin, libationJobsPending, loadBooks, loadLibationBooks]);

  useEffect(() => {
    if (libationJobs.some(isPendingJob)) {
      return;
    }
    const remainingAsins = new Set(
      [...libationFinalizingAsins].filter(
        (asin) =>
          !libationFinalizationFailures.has(asin) &&
          !libationBooks.some((book) => book.catalogId === asin && !!book.localBookId)
      )
    );
    if (remainingAsins.size === 0) {
      return;
    }
    for (const asin of remainingAsins) {
      if (!libationFinalizationStartedRef.current.has(asin)) {
        libationFinalizationStartedRef.current.set(asin, Date.now());
      }
    }

    let cancelled = false;
    let checking = false;
    let timer: number | null = null;
    const confirmDownloads = async () => {
      if (checking || remainingAsins.size === 0) {
        return;
      }
      checking = true;
      try {
        const nextBooks = await getLibationBooks();
        if (cancelled) {
          return;
        }
        setLibationBooks(nextBooks);
        setLibationBooksLoaded(true);

        const now = Date.now();
        const failedAsins: string[] = [];
        let confirmedDownload = false;
        for (const asin of remainingAsins) {
          const localBook = nextBooks.find((book) => book.catalogId === asin && !!book.localBookId);
          if (localBook) {
            confirmedDownload = true;
            remainingAsins.delete(asin);
            libationFinalizationStartedRef.current.delete(asin);
            setLibationFinalizingAsins((current) => {
              const next = new Set(current);
              next.delete(asin);
              return next;
            });
            continue;
          }
          const startedAt = libationFinalizationStartedRef.current.get(asin) ?? now;
          const timeout = currentUser.isAdmin
            ? LIBATION_CONFIRM_TIMEOUT_MS
            : LIBATION_READER_DOWNLOAD_TIMEOUT_MS;
          if (now - startedAt >= timeout) {
            failedAsins.push(asin);
            remainingAsins.delete(asin);
            libationFinalizationStartedRef.current.delete(asin);
          }
        }

        if (confirmedDownload) {
          window.setTimeout(() => void loadBooks(), 250);
        }

        if (failedAsins.length > 0) {
          setLibationFinalizingAsins((current) => {
            const next = new Set(current);
            for (const asin of failedAsins) {
              next.delete(asin);
            }
            return next;
          });
          setLibationFinalizationFailures((current) => new Set([...current, ...failedAsins]));
          const failedTitle = libationBooks.find((book) => book.asin === failedAsins[0])?.title;
          setLibationError(
            `${failedTitle ?? "The title"} never appeared in your library. Decryption or import may have failed.`
          );
        }
        if (remainingAsins.size === 0 && timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      } catch {
        // Keep the title in Adding while the server is temporarily unreachable;
        // a connection failure is not evidence that decryption failed.
      } finally {
        checking = false;
      }
    };

    void confirmDownloads();
    timer = window.setInterval(() => void confirmDownloads(), 1500);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
    // libationBooks is read once, when the check starts; the check then fetches
    // and stores fresh books itself, so listing it would restart the check
    // after every fetch it makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.isAdmin, libationFinalizationFailures, libationFinalizingAsins, libationJobs, loadBooks]);

  function trackLibationJob(job: JobStatus) {
    // Any jobs response already in flight may have been captured before this
    // POST reached the server. Invalidate it so it cannot erase the optimistic
    // job and stop the poller.
    libationJobsGenerationRef.current += 1;
    const next = [job, ...libationJobsRef.current.filter((existing) => existing.id !== job.id)];
    libationJobsRef.current = next;
    setLibationJobs(next);
  }

  async function startLibationSync() {
    setLibationError(null);
    setLibationRefreshPending(true);
    try {
      const created = await syncLibationLibrary();
      trackLibationJob({
        id: created.jobId,
        kind: "libation-sync",
        targetId: null,
        status: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Checking Audible for new purchases.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "The Audible library refresh could not be started."));
    } finally {
      setLibationRefreshPending(false);
    }
  }

  async function startLiberation(book: LibationBook) {
    setLibationError(null);
    libationFinalizationStartedRef.current.delete(book.catalogId);
    setLibationFinalizingAsins((current) => {
      const next = new Set(current);
      next.delete(book.catalogId);
      return next;
    });
    setLibationFinalizationFailures((current) => {
      const next = new Set(current);
      next.delete(book.catalogId);
      return next;
    });
    setLibationRequests((current) => new Set(current).add(book.catalogId));
    try {
      let actingUser = currentUser;
      if (isOperaLibre && !demoMode && !localMode) {
        try {
          actingUser = await getMe();
          onCurrentUserChanged(actingUser);
        } catch {
          // Let the acquisition request surface a useful server or network
          // error if the account refresh is temporarily unavailable.
        }
      }
      if (actingUser.libationAccess === "approval") {
        const request = await requestLibationBook(book.asin, book.title, book.profileId);
        setLibationDownloadRequests((current) => {
          const next = [request, ...current.filter((item) => item.id !== request.id)];
          libationDownloadRequestsRef.current = next;
          libationRequestsLoadedRef.current = true;
          return next;
        });
        return;
      }
      const created = await liberateLibationBook(book.profileId, book.asin);
      if (actingUser.isAdmin) {
        trackLibationJob({
          id: created.jobId,
          kind: "libation-liberate",
          targetId: book.catalogId,
          status: "queued",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          output: `Starting liberation for ${book.title}.`,
          error: null
        });
      } else {
        libationFinalizationStartedRef.current.set(book.catalogId, Date.now());
        setLibationFinalizingAsins((current) => new Set([...current, book.catalogId]));
      }
    } catch (error) {
      setLibationError(errorMessage(error, `The download could not be started for ${book.title}.`));
    } finally {
      setLibationRequests((current) => {
        const next = new Set(current);
        next.delete(book.catalogId);
        return next;
      });
    }
  }

  async function startAllLiberation() {
    setLibationError(null);
    setLibationAllPending(true);
    try {
      const created = await liberateAllLibationBooks();
      trackLibationJob({
        id: created.jobId,
        kind: "libation-liberate-all",
        targetId: null,
        status: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Starting Audible library sync and download for all books.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "Libation download-all could not be started."));
    } finally {
      setLibationAllPending(false);
    }
  }

  return {
    allAudibleAccounts,
    audibleAccountFilter,
    audibleAccountLabels,
    brokenLibationAccounts,
    canBrowseLibation,
    displayedLibationJobs,
    downloadAllLibationJob,
    isRefreshingAudible,
    libationAllPending,
    libationBooks,
    libationBooksLoaded,
    libationBooksRef,
    libationDownloadRequests,
    libationError,
    libationFinalizationFailures,
    libationFinalizingAsins,
    libationJobs,
    libationLoading,
    libationMessage,
    libationRefreshPending,
    libationRequests,
    libationStatus,
    libroAccounts,
    libroAvailable,
    libroOnDevice,
    libroRefreshKey,
    loadLibationBooks,
    pendingLibationJobs,
    purchaseAccountFilter,
    refreshLibationJob,
    setAudibleAccountFilter,
    setLibationBooks,
    setLibationBooksLoaded,
    setLibroAccounts,
    setLibroDestination,
    setLibroRefreshKey,
    setPurchaseAccountFilter,
    showAudiblePurchases,
    startAllLiberation,
    startLibationSync,
    startLiberation,
    visibleLibationBooks
  };
}
