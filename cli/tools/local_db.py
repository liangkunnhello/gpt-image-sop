"""本地数据库路径。

2.0.0 把投放跟踪并进主线后，客户端的安装目录（也就是数据目录）从
`GPT SOP Tracker` 换回了 `GPT Image SOP`。这些命令行工具原来写死老路径，
合并之后再跑就会把数据写进那个已经没人读的旧库 —— 所以统一走这里判断：

- 新目录存在就用新的；
- 只有老目录（还没升级到 2.0.0 的机器）才回退。
"""

from __future__ import annotations

import os
from pathlib import Path


def local_app_data() -> Path:
    return Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData' / 'Local')))


def default_db() -> Path:
    local = local_app_data()
    main = local / 'GPT Image SOP' / 'data' / 'data.db'
    if main.exists():
        return main
    return local / 'GPT SOP Tracker' / 'data' / 'data.db'


def data_dir() -> Path:
    """数据目录（data.db、images/、thumbnails/ 都在这里）。"""
    return default_db().parent
