import base64
import json
import subprocess
import urllib.request

OWNER = 'liangkunnhello'
REPO = 'gpt-image-sop'
REPO_DIR = r'C:\Users\admin\Videos\gpt_image_playground'

TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()


def api(path, method='GET', body=None):
    url = 'https://api.github.com' + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def git(*args):
    # core.quotepath=false：中文文件名按原样输出，不被转义成八进制再带引号
    return subprocess.check_output(['git', '-c', 'core.quotepath=false', *args], cwd=REPO_DIR)


ref = api(f'/repos/{OWNER}/{REPO}/git/ref/heads/main')
head_sha = ref['object']['sha']
print('远端 HEAD', head_sha)
commit = api(f'/repos/{OWNER}/{REPO}/git/commits/{head_sha}')
base_tree = commit['tree']['sha']

changed = []
for line in git('diff', '--name-status', head_sha, 'HEAD').decode('utf-8').splitlines():
    if not line.strip():
        continue
    status, path = line.split('\t', 1)
    changed.append((status, path))
print('改动', changed)

entries = []
for status, path in changed:
    if status == 'D':
        entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
        continue
    blob = git('cat-file', 'blob', f'HEAD:{path}')
    sha = api(f'/repos/{OWNER}/{REPO}/git/blobs', 'POST', {
        'content': base64.b64encode(blob).decode('ascii'),
        'encoding': 'base64',
    })['sha']
    entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha})
    print('  blob', path, sha[:8])

tree = api(f'/repos/{OWNER}/{REPO}/git/trees', 'POST', {'base_tree': base_tree, 'tree': entries})
print('新 tree', tree['sha'])

raw = git('cat-file', 'commit', 'HEAD').decode('utf-8')
message = raw.split('\n\n', 1)[1]
author_line = [l for l in raw.split('\n') if l.startswith('author ')][0]
meta = author_line[len('author '):]
name_email, ts, tz = meta.rsplit(' ', 2)
name, email = name_email[:-1].split(' <')
iso = subprocess.check_output(
    ['git', 'show', '-s', '--format=%aI', 'HEAD'], cwd=REPO_DIR, text=True
).strip()
who = {'name': name, 'email': email, 'date': iso}

new_commit = api(f'/repos/{OWNER}/{REPO}/git/commits', 'POST', {
    'message': message,
    'tree': tree['sha'],
    'parents': [head_sha],
    'author': who,
    'committer': who,
})
print('新 commit', new_commit['sha'])

local_sha = git('rev-parse', 'HEAD').decode().strip()
print('本地 commit', local_sha)
print('SHA 一致' if local_sha == new_commit['sha'] else 'SHA 不同（内容一致，历史会分叉）')

api(f'/repos/{OWNER}/{REPO}/git/refs/heads/main', 'PATCH', {'sha': new_commit['sha'], 'force': False})
print('main 已更新')
