import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MetadataEditorDialog } from '../src/MetadataEditorDialog';
import { CoverArt } from '../src/CoverArt';
import { useMetadataEditor } from '../src/useMetadataEditor';
import { library } from './performance/fixtures';
import '../src/styles.css';

localStorage.setItem('operalibre.serverUrl', location.origin);
localStorage.setItem('operalibre.serverType', 'operalibre');
const fixtures = library(2).map(book => ({ ...book, coverArtUrl: `/api/books/${book.id}/cover?v=original`,
  coverArtContentType: 'image/png', hasCoverOverride: false }));
if (new URLSearchParams(location.search).has('native')) {
  document.documentElement.classList.add('native-app');
  document.documentElement.style.setProperty('--native-viewport-height', `${window.innerHeight}px`);
  document.documentElement.style.setProperty('--native-viewport-top', '0px');
  document.documentElement.style.setProperty('--status-h', '0px');
}
function Fixture() {
  const [books, setBooks] = useState(fixtures);
  const [selectedId, setSelectedId] = useState(fixtures[0].id);
  const selectedBook = books.find(book => book.id === selectedId)!;
  const editor = useMetadataEditor({ books, currentUserId: "fixture-owner", selectedBook, setBooks });
  return <>
    <button onClick={() => editor.openMetadataEditor(selectedBook)}>Edit Info</button>
    <button id="navigate" onClick={() => setSelectedId(fixtures[1].id)}>Next book</button>
    <button id="progress" onClick={() => setBooks(previous => previous.map(book => book.id === fixtures[0].id ? {
      ...book, progress: { status: 'inProgress', bookPositionSeconds: 180, durationSeconds: 240,
        remainingSeconds: 60, percentComplete: 75, updatedAt: '2026-10-01T13:00:00Z' }
    } : book))}>Advance playback</button>
    <div data-testid="current-cover"><CoverArt book={selectedBook} size="large" /></div>
    <output data-testid="books">{JSON.stringify(books)}</output>
    {editor.metadataEditOpen && <MetadataEditorDialog books={books} editor={editor} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
