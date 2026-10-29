import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLibraryRefresh } from '../src/useLibraryRefresh';
import { usePullToRefresh } from '../src/usePullToRefresh';
import { library } from './performance/fixtures';
import type { AuthUser, LibroAccountSummary } from '../src/types';
import type { LibrarySource } from '../src/shelfSort';

function Fixture() {
  const [books, setBooks] = useState(library(1));
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<LibrarySource>('libro');
  const [audibleRefreshes, setAudibleRefreshes] = useState(0);
  const [libroRefreshes, setLibroRefreshes] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  const bookRef = useRef<string | null>(null);
  const noop = () => {};
  const { refreshShelf } = useLibraryRefresh({
    audioRef, canBrowseLibation: true, currentUser: { id: 'reader', isAdmin: false } as AuthUser,
    flushProgressSaveQueue: async () => {}, isOperaLibre: true, libationBooksLoaded: true,
    librarySource: source, libroAccounts: [{ email: 'reader@example.test' } as LibroAccountSummary],
    libroOnDevice: false, loadBooks: async () => {},
    loadLibationBooks: async () => { setAudibleRefreshes(value => value + 1); },
    localMode: false, native: false, nativeAudio: false, nativePlaybackPlayingRef: playingRef,
    pausePlayback: noop, persistProgress: async () => {}, playbackBookIdRef: bookRef,
    reconcileServerBookGains: noop, setBooks, setCurrentTrackId: noop, setError,
    setIsLoading: noop, setIsOffline: noop, setLibroRefreshKey: setLibroRefreshes,
    setNativeTab: noop, setPlaybackBookId: noop, setPosition: noop, setSelectedBookId: noop
  });
  const pull = usePullToRefresh(true, refreshShelf);
  return <>
    <label>Source <select value={source} onChange={event => setSource(event.target.value as LibrarySource)}>
      <option value="libro">Libro.fm</option><option value="all">All accounts</option>
    </select></label>
    <div data-testid="shelf" {...pull.handlers} style={{ height: 300, overflow: 'auto' }}>
      {books.map(book => <p key={book.id}>{book.title}</p>)}
    </div>
    <output data-testid="refreshing">{String(pull.refreshing)}</output>
    <output data-testid="pull">{pull.pull}</output>
    <output data-testid="audible">{audibleRefreshes}</output>
    <output data-testid="libro">{libroRefreshes}</output>
    {error && <p role="alert">{error}</p>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
