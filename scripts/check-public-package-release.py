#!/usr/bin/env python3
"""Verify the public catalog/history/download contract used by Workspace."""
import argparse
import hashlib
import io
import json
import urllib.parse
import urllib.request
import zipfile


def verify(base):
    def fetch(route):
        return urllib.request.urlopen(urllib.parse.urljoin(base, route), timeout=60).read()
    catalog = json.loads(fetch('/api/v1/resource-packages/catalog.json'))
    history = json.loads(fetch('/api/v1/releases'))
    release = next(item for item in history['releases'] if item['releaseId'] == history['latestReleaseId'])
    latest = {}
    for item in catalog['packages']:
        if item.get('deprecated') or item.get('hidden'):
            continue
        previous = latest.get(item['id'])
        if previous is None or tuple(map(int, item['version'].split('.'))) > tuple(map(int, previous['version'].split('.'))):
            latest[item['id']] = item
    results = []
    verified_archives = {}
    for item in latest.values():
        identity = f"{item['id']}@{item['version']}"
        body = fetch(item['archiveUrl'])
        verified_archives[(item['id'], item['version'])] = body
        assert len(body) == item['sizeBytes'], identity + ': size mismatch'
        assert hashlib.sha256(body).hexdigest() == item['sha256'], identity + ': archive hash mismatch'
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            manifest = json.loads(archive.read('resource-package.json'))
            assert (manifest['id'], manifest['version'], manifest['surveyId']) == (item['id'], item['version'], item['surveyId']), identity + ': identity mismatch'
            actual = sorted({layer['releaseId'] for layer in manifest['layers']})
            assert actual == sorted(item['releases']), identity + ': catalog/ZIP Release mismatch'
            for record in manifest['files'] + manifest['layers']:
                content = archive.read(record['path'])
                assert len(content) == record['sizeBytes'] and hashlib.sha256(content).hexdigest() == record['sha256'], identity + ': member hash mismatch: ' + record['path']
        for previous in catalog['packages']:
            if previous['id'] == item['id']:
                assert set(previous['releases']) <= set(actual), identity + ': unacknowledged Release removal'
        published = [p for p in release['packages'] if p['id'] == item['id']]
        assert len(published) == 1, identity + ': latest history must contain exactly one current package'
        published = published[0]
        assert (published['version'], published['sha256'], published['sizeBytes']) == (item['version'], item['sha256'], item['sizeBytes']), identity + ': history/catalog mismatch'
        assert sorted(r['id'] for r in published['releases']) == actual, identity + ': history Release mismatch'
        assert fetch(published['downloadUrl']) == body, identity + ': history download mismatch'
        results.append({'id': item['id'], 'version': item['version'], 'releases': actual, 'layers': len(manifest['layers']), 'sizeBytes': len(body), 'sha256': item['sha256'], 'archiveUrl': item['archiveUrl']})
    historical_references = 0
    for historical in history['releases']:
        for item in historical['packages']:
            identity = (item['id'], item['version'])
            body = verified_archives.get(identity)
            if body is None:
                body = fetch(item['downloadUrl'])
                verified_archives[identity] = body
            assert len(body) == item['sizeBytes'] and hashlib.sha256(body).hexdigest() == item['sha256'], str(identity) + ': historical download mismatch'
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                manifest = json.loads(archive.read('resource-package.json'))
                assert sorted({layer['releaseId'] for layer in manifest['layers']}) == sorted(r['id'] for r in item['releases']), str(identity) + ': historical Release mismatch'
            historical_references += 1
    collection = release['collection']
    content = fetch(collection['downloadUrl'])
    assert len(content) == collection['sizeBytes'] and hashlib.sha256(content).hexdigest() == collection['sha256'], 'Collection hash mismatch'
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        for item in latest.values():
            matches = [name for name in archive.namelist() if name.endswith(f"{item['id']}-{item['version']}.zip")]
            assert len(matches) == 1, 'Missing package in collection: ' + item['id']
            assert hashlib.sha256(archive.read(matches[0])).hexdigest() == item['sha256']
    return {'releaseId': release['releaseId'], 'packages': results, 'collection': collection, 'historicalPackageReferences': historical_references, 'status': 'passed'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_url')
    args = parser.parse_args()
    print(json.dumps(verify(args.base_url), indent=2))
