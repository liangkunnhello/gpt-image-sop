"""
走 GitHub API 推送（git push 走 HTTPS 经常 502）。

为什么不直接 git diff 远端 SHA：API 建出来的提交对象只存在于 GitHub，
本机没有那个 commit，`git diff <远端SHA> HEAD` 会直接报
"unknown revision"。所以这里改成两边各取一份「路径 → blob SHA」的清单自己比，
本机有没有远端历史都无所谓。
"""

import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

OWNER = 'liangkunnhello'
REPO = 'gpt-image-sop'
REPO_DIR = r'C:\Users\admin\Videos\gpt_image_playground'

TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()


def api(path, method='GET', body=None, retries=4):
    """调 GitHub API。

    GitHub 侧偶发 500/502（建 blob、建 tree 都会遇到），重试一次基本就过；
    只在 5xx 和网络错误时重试，4xx 是真的参数问题，重试没有意义。
    """
    url = 'https://api.github.com' + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', 'Bearer ' + TOKEN)
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as err:
            if err.code < 500:
                raise
            last = err
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
        if attempt < retries - 1:
            wait = 2 ** attempt
            print(f'  API 暂时失败（{last}），{wait} 秒后重试…')
            time.sleep(wait)
    raise last


def git(*args):
    # core.quotepath=false：中文文件名按原样输出，不被转义成八进制再带引号
    return subprocess.check_output(['git', '-c', 'core.quotepath=false', *args], cwd=REPO_DIR)


def local_blobs():
    """本地 HEAD 的全部文件：路径 → (mode, blob sha)"""
    out = git('ls-tree', '-r', 'HEAD').decode('utf-8')
    items = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        meta, path = line.split('\t', 1)
        mode, kind, sha = meta.split()
        if kind != 'blob':
            # 子模块（commit）不在这里推，避免把引用推坏
            continue
        items[path] = (mode, sha)
    return items


def remote_blobs(tree_sha):
    """远端 tree 的全部文件：路径 → (mode, blob sha)"""
    data = api(f'/repos/{OWNER}/{REPO}/git/trees/{tree_sha}?recursive=1')
    if data.get('truncated'):
        raise SystemExit('远端 tree 被截断（文件过多），这次请改用 git 推送')
    items = {}
    for entry in data['tree']:
        if entry['type'] != 'blob':
            continue
        items[entry['path']] = (entry['mode'], entry['sha'])
    return items


# 目标分支：默认 main，可用第一个参数指定（远端还没有该分支时从 main 拉）
BRANCH = sys.argv[1] if len(sys.argv) > 1 else 'main'
try:
    ref = api(f'/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}')
    branch_exists = True
except urllib.error.HTTPError as err:
    if err.code != 404:
        raise
    # 新分支：以远端 main 为基础，把本地改动整体应用上去
    ref = api(f'/repos/{OWNER}/{REPO}/git/ref/heads/main')
    branch_exists = False
head_sha = ref['object']['sha']
print(f'目标分支 {BRANCH}（{"已有" if branch_exists else "新建，基于 main"}），远端 HEAD {head_sha}')
commit = api(f'/repos/{OWNER}/{REPO}/git/commits/{head_sha}')
base_tree = commit['tree']['sha']

local = local_blobs()
remote = remote_blobs(base_tree)

entries = []
for path, (mode, sha) in sorted(local.items()):
    prev = remote.get(path)
    if prev and prev[1] == sha:
        continue
    # 内容变了：把本机这份 blob 传上去，拿回 GitHub 的 sha（内容相同则 sha 相同）
    blob = git('cat-file', 'blob', f'HEAD:{path}')
    new_sha = api(f'/repos/{OWNER}/{REPO}/git/blobs', 'POST', {
        'content': base64.b64encode(blob).decode('ascii'),
        'encoding': 'base64',
    })['sha']
    entries.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': new_sha})
    print('  ', '新增' if prev is None else '修改', path, new_sha[:8])

for path in sorted(remote):
    if path in local:
        continue
    entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
    print('   删除', path)

if not entries:
    print('远端已经和本地一致，没有要推的内容')
    raise SystemExit(0)

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
print('SHA 一致' if local_sha == new_commit['sha'] else 'SHA 不同（内容一致，远端以自己的提交序号为准）')

if branch_exists:
    api(f'/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}', 'PATCH', {'sha': new_commit['sha'], 'force': False})
    print(f'{BRANCH} 已更新')
else:
    api(f'/repos/{OWNER}/{REPO}/git/refs', 'POST', {
        'ref': f'refs/heads/{BRANCH}',
        'sha': new_commit['sha'],
    })
    print(f'{BRANCH} 已创建')
