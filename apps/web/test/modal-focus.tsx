import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudiobookUploadDialog, EbookUploadDialog } from '../src/UploadDialogs';
import { SyncConfirmationDialog, UnplayedConfirmationDialog } from '../src/ConfirmDialogs';
import { SpeedSheet } from '../src/PlayerSheets';
import { MetadataEditorDialog } from '../src/MetadataEditorDialog';
import { useMetadataEditor } from '../src/useMetadataEditor';
import { library } from './performance/fixtures';
import '../src/styles.css';

const book = library(1)[0];
function Fixture() {
  const [books, setBooks] = useState([{ ...book, metadata: { ...book.metadata, series: 'Example series' } }]);
  const editor = useMetadataEditor({ books, currentUserId: 'modal-test', selectedBook: books[0], setBooks });
  const [modal, setModal] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const close = () => setModal('');
  return <>
    <button onClick={() => setModal('upload')}>Open upload</button>
    <button onClick={() => setModal('ebook')}>Open ebook</button>
    <button onClick={() => setModal('sync')}>Open sync</button>
    <button onClick={() => setModal('unplayed')}>Open unplayed</button>
    <button onClick={() => setModal('speed')}>Open speed</button>
    <button onClick={() => editor.openMetadataEditor(books[0])}>Open metadata</button>
    <button id="outside">Outside action</button>
    <label><input type="checkbox" checked={busy} onChange={event => setBusy(event.target.checked)} />Busy</label>
    {modal === 'upload' && <AudiobookUploadDialog chooseUploadFiles={() => {}} native={false}
      setUploadBookName={setName} setUploadModalOpen={close} submitAudiobookUpload={async event => event.preventDefault()}
      uploadBookName={name} uploadBusy={busy} uploadError={null} uploadFiles={[]} />}
    {modal === 'ebook' && <EbookUploadDialog chooseDeviceEbookUpload={async () => {}} chooseEbookUpload={() => {}}
      ebookUploadBook={book} ebookUploadBusy={busy} ebookUploadError={null} ebookUploadFile={null}
      native={false} setEbookUploadBook={close} submitEbookUpload={async event => event.preventDefault()} />}
    {modal === 'sync' && <SyncConfirmationDialog setSyncConfirmationBook={close} startSyncGeneration={async () => {}} syncConfirmationBook={book} />}
    {modal === 'unplayed' && <UnplayedConfirmationDialog completionError={null}
      completionPendingBookId={busy ? book.id : null} confirmBookUnplayed={async () => {}}
      setCompletionError={() => {}} setUnplayedConfirmationBookId={close} unplayedConfirmationBook={book} />}
    {modal === 'speed' && <SpeedSheet closeNativePlayerSheet={close} playbackBook={book} playbackCanBoost={false}
      playbackGain={0} setNativePlayerSheet={close} speed={1} updateBookGain={() => {}} updateSpeed={() => {}} />}
    {editor.metadataEditOpen && <MetadataEditorDialog books={books} editor={editor} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
