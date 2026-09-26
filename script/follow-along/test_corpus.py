import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import corpus


def epub(path, title='Sample'):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('META-INF/container.xml', '<container><rootfile full-path="book.opf"/></container>')
        z.writestr('book.opf', f'<package><title>{title}</title><creator>Fixture Author</creator><itemref/></package>')


class CorpusContracts(unittest.TestCase):
    def test_pairing_never_assigns_unrelated_audio_from_a_shared_folder(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)
            epub(p / 'One.epub')
            (p / 'One.m4b').touch(); (p / 'Another.m4b').touch()
            book = corpus.inventory(root)['books'][0]
            self.assertEqual(book['audio'], str((p / 'One.m4b').resolve()))
            (p / 'One.m4b').unlink()
            (p / 'Third.mp3').touch()
            book = corpus.inventory(root)['books'][0]
            self.assertEqual(book['status'], 'ambiguous')
            self.assertIsNone(book['audio'])

    def test_missing_and_broken_books_are_reported_not_dropped(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)
            epub(p / 'One.epub'); (p / 'Broken.epub').write_text('broken')
            self.assertEqual({b['status'] for b in corpus.inventory(root)['books']}, {'invalid-epub', 'missing-audio'})

    def test_seeded_sampling_covers_beginning_middle_end_and_small_books(self):
        scopes = [{'index': i, 'audioRange': [i * 60, i * 60 + 60], 'mappedText': 'word ' * 50} for i in range(12)]
        selected = corpus.select_scopes(scopes, 'frozen')
        self.assertEqual(selected, corpus.select_scopes(scopes, 'frozen'))
        self.assertEqual([i // 4 for i in selected], [0, 1, 2])
        self.assertEqual(corpus.select_scopes(scopes[:2], 'frozen'), [0, 1])

    def test_unmatched_eligible_narration_stays_in_the_denominator(self):
        value = {'fragments': [{'startSeconds': 0, 'endSeconds': 2, 'href': 'one', 'text': 'Correct sentence.'}]}
        labels = [{'kind': 'prose', 'at': 1, 'href': 'one', 'text': 'Correct sentence.'},
                  {'kind': 'prose', 'at': 3, 'href': 'one', 'text': 'Missing sentence.'}]
        result = corpus.score_labels(value, labels)
        self.assertEqual(result['accuracy'], .5)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(corpus.score_labels(value, [])['status'], 'unverified')

    def test_real_edition_differences_need_reasons_and_must_not_be_forced(self):
        value = {'fragments': [{'startSeconds': 10, 'endSeconds': 20, 'href': 'one', 'text': 'Shared passage.'}]}
        labels = [{'kind': 'unmatched', 'at': 5, 'reason': 'Narrator reads an added passage absent from this edition'},
                  {'kind': 'prose', 'at': 12, 'href': 'one', 'text': 'Shared passage.'}]
        self.assertEqual(corpus.score_labels(value, labels)['status'], 'passed')
        value['fragments'].insert(0, {'startSeconds': 0, 'endSeconds': 9, 'href': 'wrong', 'text': 'Forced incorrect prose.'})
        self.assertEqual(corpus.score_labels(value, labels)['status'], 'failed')
        with self.assertRaises(ValueError):
            corpus.score_labels(value, [{'kind': 'unmatched', 'at': 5}])

    def test_high_average_cannot_hide_a_wrong_chapter_jump(self):
        value = {'fragments': [{'startSeconds': i * 2, 'endSeconds': i * 2 + 2,
                               'href': 'wrong' if i == 99 else 'one', 'text': 'Shared words.'} for i in range(100)]}
        labels = [{'kind': 'prose', 'at': i * 2 + 1, 'href': 'one', 'text': 'Shared words.'} for i in range(100)]
        result = corpus.score_labels(value, labels)
        self.assertEqual(result['accuracy'], .99)
        self.assertEqual(result['status'], 'failed')

    def test_chapter_jump_invalid_clocks_and_utf16_offsets_fail_integrity(self):
        scope = {'audioRange': [10, 20], 'hrefs': ['one'], 'mappedText': 'Café 🦉.'}
        good = {'fragments': [{'startSeconds': 10, 'endSeconds': 15, 'href': 'one', 'text': 'Café 🦉.', 'words': [[10, 11, 5, 2]]}]}
        self.assertEqual(corpus.validate_map(good, scope), [])
        good['fragments'][0]['words'][0][3] = 20
        good['fragments'][0]['href'] = 'wrong'
        good['fragments'][0]['startSeconds'] = float('nan')
        self.assertEqual(len(corpus.validate_map(good, scope)), 3)

    def test_failed_first_run_cannot_be_relabelled_first_run_or_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root); (p / 'book.epub').write_text('epub'); (p / 'book.wav').write_text('audio')
            plan = {'books': [{'id': 'book', 'title': 'Book', 'status': 'planned', 'role': 'holdout',
                              'epub': str(p / 'book.epub'), 'audio': str(p / 'book.wav'),
                              'epubSha256': corpus.digest(p / 'book.epub'), 'scopes': [0]}]}
            corpus.save(p / 'plan.json', plan)
            with patch.object(corpus, 'probe', side_effect=ValueError('Interrupted')):
                first = corpus.run_plan(p / 'plan.json', p / 'first', '/cli', '/ffmpeg', None)
                repeat = corpus.run_plan(p / 'plan.json', p / 'repeat', '/cli', '/ffmpeg', None)
                self.assertEqual(first['books'][0]['status'], 'failed')
                self.assertEqual(first['books'][0]['attempt'], 'first-recorded')
                self.assertEqual(repeat['books'][0]['attempt'], 'repeat')
                with self.assertRaises(FileExistsError):
                    corpus.run_plan(p / 'plan.json', p / 'first', '/cli', '/ffmpeg', None)
            self.assertEqual(json.loads((p / 'attempts/book.json').read_text())['run'], str((p / 'first').resolve()))


if __name__ == '__main__':
    unittest.main()
