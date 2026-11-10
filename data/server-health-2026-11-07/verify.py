"""Validate the delivered census, including the first scan's missed user paths."""
import collections
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import tarfile

base = Path(__file__).parent
score = json.loads((base / 'semantic-score.json').read_text())
for file, expected in score['ruleInputs'].items():
    assert hashlib.sha256((base / file).read_bytes()).hexdigest() == expected, file
summary = json.loads((base / 'candidate-summary.json').read_text())
with (base / 'semantic-sites.csv').open() as stream:
    rows = list(csv.DictReader(stream))
assert len(rows) == score['candidates'] == summary['candidates']
assert collections.Counter(row['disposition'] for row in rows) == score['byDisposition']
counted = [row for row in rows if row['counted'] == 'true']
assert len(counted) == score['score'] == sum(score['byCategory'].values())
assert len(rows) - len(counted) == score['excluded']
assert not any('unclassified' in row['disposition'] or 'review' in row['disposition'] for row in rows)
assert all(row['reason'] and row['evidence'] for row in rows)
assert len({row['id'] for row in rows}) == len(rows)
assert collections.Counter(row['category'] for row in counted) == score['byCategory']
archive = subprocess.check_output(['git', 'archive', score['sourceSha'], 'apps/server'])
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    files = {entry.name: source.extractfile(entry).read() for entry in source if entry.isfile()}
manifest = {item['file']: item for item in score['files']}
excluded_files = {item['file'] for item in score['nonCodeFiles']}
assert set(files) == set(manifest) | excluded_files
assert not set(manifest) & excluded_files
for file, item in manifest.items():
    assert hashlib.sha256(files[file]).hexdigest() == item['sha256'], file
    own = [row for row in rows if row['file'] == file]
    assert len(own) == item['candidates']
    assert sum(row['counted'] == 'true' for row in own) == item['retained']
    assert all(1 <= int(row['line']) <= len(files[file].splitlines()) for row in own)

def site(file, line, category, column=None):
    found = [row for row in rows if row['file'] == 'apps/server/' + file
             and int(row['line']) == line and row['category'] == category
             and (column is None or int(row['column']) == column)]
    assert len(found) == 1, (file, line, category, len(found))
    return found[0]

# A throw elsewhere does not erase an actual swallowed/continued failure path.
assert site('src/daemon/message-reads.ts', 203, 'exception-handler')['counted'] == 'true'
# The raw newlines in these handlers/predicates must survive comment parsing.
assert site('src/database.ts', 233, 'exception-handler')['counted'] == 'false'
assert site('src/database.ts', 327, 'exception-handler')['counted'] == 'false'
assert site('src/database.ts', 484, 'exception-handler')['counted'] == 'false'
assert site('src/database.ts', 491, 'exception-handler')['counted'] == 'true'
for file in ['src/daemon-service.ts', 'src/phone-service.ts']:
    slots = [row for row in rows if row['file'] == 'apps/server/' + file
             and '_legacyProviderSlot' in row['evidence'] and row['category'] == 'parameter']
    assert len(slots) == 1 and slots[0]['disposition'] == 'avoidable-compatibility'
assert site('src/owner-schedule-clock.ts', 17, 'retry-sleep-or-scheduling-candidate')['counted'] == 'false'
assert site('src/free-agents.ts', 950, 'retry-sleep-or-scheduling-candidate')['counted'] == 'false'
gates = [row for row in rows if row['category'] == 'disabled-or-conditional-test']
assert len(gates) == 47
assert len({(row['file'], row['line']) for row in gates}) == 47
assert all(row['disposition'] == 'retained-test-environment' for row in gates)
assert any(row['file'].endswith('assets/game.template.html') and row['counted'] == 'true' for row in rows)
assert any(row['file'].endswith('rooms-mcp-consent-ui.ts') and row['owner'] == 'update' for row in rows)
assert any(row['category'] == 'sql-case-policy' and row['evidence'].startswith('IF ') for row in counted)
# Mode spelling is not evidence of harmlessness: assert the reviewed bypasses.
for file, line, column in [
    ('src/commander.ts', 45, 3),
    ('src/commander.ts', 66, 64),
    ('src/rooms-mcp-oauth.ts', 154, 39),
    ('src/rooms-mcp-oauth.ts', 154, 58),
    ('src/agent-command-route-agent-result.ts', 331, 3),
    ('src/github-operations-begin-identity.ts', 35, 5),
    ('src/subscription-webhooks.ts', 81, 102),
    ('src/subscription-webhooks.ts', 81, 164),
    ('src/resource-requester.ts', 24, 47),
    ('src/phone/corner-reads.ts', 62, 5),
    ('src/database.ts', 57, 3),
    ('src/composio-apps.ts', 433, 5),
    ('src/rooms-mcp-members.ts', 214, 54),
]:
    assert site(file, line, 'parameter', column)['disposition'] == 'retained-caller-policy'
for file, line, column in [
    ('src/agent-schedules.ts', 311, 5),
    ('src/operator-dashboard.ts', 42, 3),
    ('src/chat-corner-counts.ts', 209, 60),
]:
    assert site(file, line, 'parameter', column)['disposition'] == 'ordinary-control-flow'
for file, line, column in [
    ('src/connection-presence.ts', 63, 66),
    ('src/connection-presence.ts', 169, 3),
    ('src/daemon-live.ts', 336, 9),
]:
    assert site(file, line, 'parameter', column)['disposition'] == 'avoidable-compatibility'
reviews = json.loads((base / 'parameter-adjudications.json').read_text())
facts = json.loads(Path('.beeline-proof/server-health-candidate-facts.json').read_text())
mode_keys = {f"{row['file'].replace('apps/server/', '')}:{row['line']}:{row['column']}"
             for row in facts if row['category'] == 'parameter' and row.get('modeKind')}
assert mode_keys <= set(reviews)
assert score['parameterAudit'] == {'reviewed': len(reviews), 'modeParameters': len(mode_keys)}
for row in rows:
    key = f"{row['file'].replace('apps/server/', '')}:{row['line']}:{row['column']}"
    if row['category'] == 'parameter' and key in reviews:
        assert row['disposition'] == reviews[key]['disposition']
        assert row['reason'] == reviews[key]['reason']
        assert row['evidence'] == reviews[key]['parameter']
# Exercise the real generator with one missing mode decision, without changing
# the published catalog or source facts. It must fail rather than default ordinary.
with tempfile.TemporaryDirectory(prefix='census-missing-mode-', dir='.beeline-proof') as directory:
    target = Path(directory)
    for file in ['adjudicate.mjs', 'candidate-summary.json', 'adjudication-overrides.json']:
        shutil.copyfile(base / file, target / file)
    missing = dict(reviews)
    del missing['src/commander.ts:45:3']
    (target / 'parameter-adjudications.json').write_text(json.dumps(missing))
    result = subprocess.run(['node', str(target / 'adjudicate.mjs')], capture_output=True, text=True)
    assert result.returncode != 0
    assert 'Missing parameter adjudication: src/commander.ts:45:3' in result.stderr
print(json.dumps({'filesAccountedFor': len(files), 'parsedFiles': len(manifest),
                  'discoveryRows': len(rows), 'score': len(counted),
                  'excludedRows': score['excluded'], 'modeParameters': len(mode_keys),
                  'parameterAdjudications': len(reviews), 'missingModeGuard': 'PASS', 'status': 'PASS'}, indent=2))
