import json
import subprocess
import urllib.request

OWNER = 'liangkunnhello'
REPO = 'gpt-image-sop'
REPO_DIR = r'C:\Users\admin\Videos\gpt_image_playground'
TAG = 'v0.9.0'

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
    return subprocess.check_output(['git', *args], cwd=REPO_DIR, text=True)


commit_sha = git('rev-parse', f'{TAG}^{{commit}}').strip()
message = git('cat-file', 'tag', TAG)
message = message.split('\n\n', 1)[1].rstrip('\n')
iso = subprocess.check_output(
    ['git', 'for-each-ref', f'refs/tags/{TAG}', '--format=%(taggerdate:iso-strict)'],
    cwd=REPO_DIR, text=True,
).strip()

tag_obj = api(f'/repos/{OWNER}/{REPO}/git/tags', 'POST', {
    'tag': TAG,
    'message': message,
    'object': commit_sha,
    'type': 'commit',
    'tagger': {
        'name': 'liangkunnhello',
        'email': 'liangkunnhello@users.noreply.github.com',
        'date': iso,
    },
})
print('tag object', tag_obj['sha'])
print('本地 tag   ', git('rev-parse', TAG).strip())

api(f'/repos/{OWNER}/{REPO}/git/refs', 'POST', {
    'ref': f'refs/tags/{TAG}',
    'sha': tag_obj['sha'],
})
print('tag ref 已创建')

body = """## v0.9.0 · SOP 生图工作台

基于 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 改造，面向「参考图 → 反推系统提示词 → 生成 SOP → 批量出图」的内容生产流程。

### 新增
- **SOP 生图模式**：拖入参考图 → 反推生图 SOP → 按 SOP 批量写提示词 → 每条提示词出一张图，同组图片聚合成一张任务卡
- **产品-方向任务栏**：类目 / 产品 / 方向三级层级，常驻可收起，任意层级筛选，任务按当前选择归属；多选后可批量设置归属
- **卖点 / 风格预设**：挂在产品下共享，方向记录上次选择，支持右键设默认、编辑、删除与「不使用」
- **生成开关**：不参考 logo 与合规文案（默认开）、使用参考图上的卖点文案（默认关）
- **详情瀑布流**：按目标列宽自适应，底部提供 50%–300% 无级缩放
- **尺寸适配**：按渠道能力置灰不支持的比例，显示每个比例的最大可用分辨率
- **Agent 文本配置**：为空时可一键用当前渠道地址与密钥派生一份 Responses API 配置

### 修复
- SOP 模式输入框为空也能发送
- 发送后立即插入占位卡并展示进度，界面不再被阻塞（后台队列并发 10）
- 详情弹窗展示同一 SOP 下的全部图片
- 复用配置时回填参考图
- 删除 SOP 卡片时整组任务一起删除（含批量删除）
- 生成时不再带出免责声明与警示语

### 说明
- 文本模型可在「设置 → 接口配置 → 反推与提示词模型」中指定，支持从渠道拉取模型列表
- 视频模型仅列出，当前版本不含视频生成链路
"""

release = api(f'/repos/{OWNER}/{REPO}/releases', 'POST', {
    'tag_name': TAG,
    'name': 'v0.9.0 · SOP 生图工作台',
    'body': body,
    'draft': False,
    'prerelease': False,
})
print('release', release['html_url'])
