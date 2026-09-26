import unittest
from pathlib import Path
import tempfile
import audit
import corpus

class IndependentReferenceTests(unittest.TestCase):
    def test_reference_locations_are_unique_and_do_not_use_any_map(self):
        text='A traveler carried the blue lantern across a narrow wooden bridge before dawn.'
        sections=[{'href':'one','text':text}]
        recognized=[dict(text=t,start=i,end=i+.5) for i,t in enumerate(audit.tokens(text))]
        checks=audit.reference_checks(recognized,sections,100)
        self.assertGreater(len(checks),0)
        self.assertEqual(checks[0]['at'],104.25)
        self.assertEqual(audit.reference_checks(recognized,sections+sections,100),[])
        self.assertEqual(audit.reference_checks([],sections,100),[])

    def test_missing_and_wrong_chapter_highlights_are_failures(self):
        text='A traveler carried the blue lantern across a narrow wooden bridge before dawn.'
        sections=[{'href':'one','text':text},{'href':'two','text':'Unrelated words.'}]
        recognized=[dict(text=t,start=i,end=i+.5) for i,t in enumerate(audit.tokens(text))]
        checks=audit.reference_checks(recognized,sections,0)*4
        value={'fragments':[{'startSeconds':0,'endSeconds':30,'href':'one','text':text}]}
        self.assertEqual(audit.score(value,checks,sections)['sentenceAgreement'],1)
        value['fragments'][0]['href']='two'
        result=audit.score(value,checks,sections)
        self.assertEqual(result['sentenceAgreement'],0)
        self.assertGreater(result['wrongChapterChecks'],0)
        self.assertEqual(audit.score({'fragments':[]},checks,sections)['sentenceAgreement'],0)

    def test_invalid_reference_clocks_are_not_eligible(self):
        raw=[dict(type='word',text='good',startTime=1,endTime=2),
             dict(type='word',text='bad',startTime=float('nan'),endTime=3)]
        self.assertEqual(len(audit.words(raw)),1)
        self.assertEqual(audit.tokens('can’t re-enter'),['cant','re','enter'])

    def test_audit_uses_real_reader_pause_and_recovery_behavior(self):
        text='A traveler carried a lantern across the bridge.'
        sections=[dict(href='one',text=text+' The next sentence.')]
        checks=[dict(at=2.5,referenceStart=1.5,referenceEnd=2.6,section=0,href='one',token=0)]*20
        value=dict(fragments=[dict(startSeconds=0,endSeconds=2,href='one',text=text),
                              dict(startSeconds=4,endSeconds=5,href='one',text='The next sentence.')])
        selected=audit.reader_selection(value,checks)
        result=audit.score(value,checks,sections,selected)
        self.assertEqual(result['sentenceAgreement'],0)
        self.assertEqual(result['readerAgreement'],1)
        self.assertEqual(result['status'],'passed')
        value['recoveryGaps']=[dict(startSeconds=2,endSeconds=4)]
        result=audit.score(value,checks,sections,audit.reader_selection(value,checks))
        self.assertEqual(result['readerAgreement'],0)
        self.assertEqual(result['status'],'failed')

    def test_repeated_utterances_use_map_neighbors_not_expected_labels(self):
        text='First group begins here. Stay here. Another group begins later. Stay here. Last visitors leave.'
        sections=[dict(href='one',text=text)]
        value=dict(fragments=[dict(startSeconds=0,endSeconds=1,href='one',text='Another group begins later.'),
                              dict(startSeconds=3,endSeconds=4,href='one',text='Stay here.'),
                              dict(startSeconds=5,endSeconds=6,href='one',text='Last visitors leave.')])
        checks=[dict(at=3.5,referenceStart=3,referenceEnd=4,section=0,href='one',token=10)]*20
        self.assertEqual(audit.score(value,checks,sections,[1]*20)['readerAgreement'],1)
        self.assertEqual(audit.score(dict(fragments=[value['fragments'][1]]),checks,sections,[0]*20)['readerAgreement'],0)

    def test_every_planned_scope_must_have_a_reference_and_map(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); reference=root/'reference'; reference.mkdir()
            corpus.save(root/'input.json',{'sections':[]})
            corpus.save(root/'scopes.json',[])
            corpus.save(root/'plan.json',{'books':[dict(id='one',title='Book',status='planned',scopes=[0,1],scopeManifest=str(root/'scopes.json'))]})
            corpus.save(reference/'report.json',dict(planSha256=corpus.digest(root/'plan.json'),books=[dict(id='one',scopes=[dict(index=0)])]))
            result=audit.compare(root/'plan.json',reference,root/'maps',root/'audit.json')
            book=result['books'][0]
            self.assertEqual(book['status'],'needs-review')
            self.assertEqual([s['status'] for s in book['scopes']],['missing-or-ambiguous-map','missing-reference-scope'])
            plan=corpus.load(root/'plan.json')
            plan['books'].insert(0,dict(id='broken',title='Broken',status='planned',scopes=[0],scopeManifest=str(root/'missing/scopes.json')))
            corpus.save(root/'plan.json',plan)
            ref=corpus.load(reference/'report.json'); ref['planSha256']=corpus.digest(root/'plan.json')
            corpus.save(reference/'report.json',ref)
            result=audit.compare(root/'plan.json',reference,root/'maps',root/'audit-broken.json')
            self.assertEqual([b['status'] for b in result['books']],['audit-error','needs-review'])

if __name__=='__main__': unittest.main()
