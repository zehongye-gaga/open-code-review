# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 alibaba/open-code-review Contributors

# SPDX-License-Identifier: Apache-2.0
import importlib.util,tempfile,pathlib,json,time,unittest,unittest.mock
spec=importlib.util.spec_from_file_location('resources',str(pathlib.Path(__file__).with_name('resource-history.py')));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_outage_and_retention(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'2000-01-01.jsonl').write_text('{}');(p/'keep.txt').write_text('safe')
   with unittest.mock.patch.object(m.urllib.request,'urlopen',side_effect=OSError()):
    r=m.record(d,{'cpu':1,'memory':2},3,time.time(),None,p/'missing','http://localhost')
   self.assertFalse(r['load']['available']);self.assertNotIn('running',r['load']);self.assertFalse((p/'2000-01-01.jsonl').exists());self.assertTrue((p/'keep.txt').exists())
 def test_matching_sample(self):
  with tempfile.TemporaryDirectory() as d:
   health={'status':'ok','running':3,'prConcurrency':8,'dispatching':2,'dispatchConcurrency':8,'queued':4,'activeJobs':[]}
   with unittest.mock.patch.object(m,'collect_load',return_value={'available':True,'running':3,'queued':4}):
    m.record(d,{'cpu':20,'memory':10},4,time.time(),None,'unused','unused')
   self.assertEqual(m.report(d)[0],{'running':3,'samples':1,'cpu_mean':20,'cpu_max':20,'memory_max':10,'queue_max':4})
unittest.main()
