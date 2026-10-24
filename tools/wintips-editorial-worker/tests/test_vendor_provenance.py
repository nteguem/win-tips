"""Bind collector ports to their exact LF bytes and per-file upstream origin."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

VENDOR = Path(__file__).resolve().parents[1] / 'editorial_worker/vendor'
UPSTREAM_COMMIT = 'add3ed09f0cd53a822524c0dd731ccd483096d94'
HISTORICAL_TRANSLATION_COMMIT = 'fed52531237c300d077df25766be022d9ed661c1'
UPSTREAM = {
    'rdj_collector.py': ('collector.py', 'fbfb90156859f97fef755f52fe86950f12a269c83806a32eb46fb0fa51b207f5',
                         'cc78d9d78a2e23370cad2075f3722f076a25029d'),
    'timing.py': ('timing.py', '9b7e778a609990d9e719e0702002f5b29476fd8311c012f926e7dee162277df1',
                  '61615210a0766c16e3db8b27ad8d17d2397990de'),
}


def lf_digest(raw):
    # Git checkout CRLF is the sole permitted representation difference.
    raw.decode('utf-8', errors='strict')
    return hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest()


class VendorProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((VENDOR / 'provenance.json').read_text('utf-8'))

    def row(self, name):
        rows = [row for row in self.manifest['files'] if row['file'] == name]
        self.assertEqual(len(rows), 1, 'Exactly one provenance entry is required per module')
        return rows[0]

    def assert_current_port(self, name):
        row = self.row(name)
        upstream_file, upstream_digest, blob = UPSTREAM[name]
        self.assertEqual(row['originCommit'], UPSTREAM_COMMIT)
        self.assertEqual(row['upstreamPath'], 'tools/journal-parieur-worker/journal_worker/' + upstream_file)
        self.assertEqual(row['upstreamSha256'], upstream_digest)
        self.assertEqual(row['upstreamNormalizedUtf8Sha256'], upstream_digest)
        self.assertEqual(row['upstreamGitBlob'], blob)
        self.assertEqual(row['lineEndings'], 'LF')
        raw = (VENDOR / name).read_bytes()
        self.assertEqual(lf_digest(raw), row['sha256'])
        self.assertEqual(lf_digest(raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')), row['sha256'])
        self.assertNotEqual(lf_digest(raw + b'\n# undocumented code drift\n'), row['sha256'])

    def test_collector_port_has_current_origin_and_exact_vendored_bytes(self):
        self.assert_current_port('rdj_collector.py')

    def test_timing_port_has_current_origin_and_exact_vendored_bytes(self):
        self.assert_current_port('timing.py')

    def test_updating_collectors_does_not_relabel_historical_translation(self):
        row = deepcopy(self.row('rdj_translation.py'))
        self.assertEqual(row.pop('originCommit'), HISTORICAL_TRANSLATION_COMMIT)
        # This records preservation of the existing historical row, not a
        # claim that its old snapshot hash describes today's translation code.
        canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(hashlib.sha256(canonical).hexdigest(),
                         '698dff4d496b8cd5996d7513864c67afbd2f4c407b9b7d36fc7512e869f43a03')
        self.assertEqual(self.manifest['initialSnapshotCommit'], HISTORICAL_TRANSLATION_COMMIT)
        separate = json.loads((VENDOR / 'translation-provenance.json').read_text('utf-8'))
        self.assertEqual(separate['originCommit'], '891de82290cc39f4f04ad79281e430496bfba002')


if __name__ == '__main__':
    unittest.main()
