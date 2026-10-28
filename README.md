# piagentlark（pi-lark bridge）

飞书 / Lark ↔ pi 编码代理桥接器：在飞书聊天里直接与 pi 对话——流式卡片展示回答、思考摘要、工具调用与用量，支持图片/文件附件、斜杠命令、按用户隔离的会话，以及后台运行与单实例锁。

## 一键安装（pi 命令）

```bash
pi install git:github.com/AdvBuddy/piagentlark
```

等价写法：`pi install https://github.com/AdvBuddy/piagentlark`；本地开发安装：`pi install ./`。安装后重启 pi 会话即可。

要求：pi ≥ 1.4、Node ≥ 20.12。pi 会自动安装运行依赖（`@larksuiteoapi/node-sdk`、`cross-spawn`），桥接器运行时使用仓库内置的构建产物（`dist/`），无需额外构建。

## 快速开始（pi 扩展方式，推荐）

1. `/lark-setup` —— 打开链接创建/更新飞书自建应用，凭据自动写入 `~/.pi/lark/.env`
   - 链接会完整显示并复制到剪贴板；**SSH 终端**下通过 OSC 52 写入本地剪贴板，请在本地浏览器打开
   - 不自动打开浏览器
2. `/lark-start` —— 后台启动桥接器并连接飞书（就绪后提示）
3. 在飞书里直接给机器人发消息；群聊需 @机器人

| 命令 | 作用 |
|---|---|
| `/lark`、`/lark-setup` | 状态总览 / 扫码链接配置 |
| `/lark-start`、`/lark-stop`、`/lark-restart` | 后台生命周期 |
| `/lark-logs`、`/lark-config` | 查看日志 / 修改配置项 |
| `/lark-uninstall` | 一键卸载：停止桥接器并删除全部本地数据 |

## 卸载

在 pi 中运行 `/lark-uninstall`（确认后停止后台桥接器，删除 `~/.pi/lark/` 下的凭据、会话、日志与附件），然后移除扩展本体：

```bash
pi remove git:github.com/AdvBuddy/piagentlark
```

## 独立运行（不经 pi 扩展）

```bash
git clone https://github.com/AdvBuddy/piagentlark
cd piagentlark
npm install
npm run setup   # 配置向导（创建应用并写入 .env）
npm start       # 前台运行，Ctrl+C 停止
```

## 配置

全部环境变量与默认值见 [`.env.example`](.env.example)。要点：

- `FEISHU_CONNECTION_MODE` 默认 `websocket` 长连接，无需公网地址
- `FEISHU_ALLOWED_USERS` / `FEISHU_GROUP_POLICY` 控制谁能使用
- `PI_APPROVE` 默认 `true`：**会自动执行被桥接仓库内的 pi 扩展/资源**，桥接不信任的仓库时请设为 `false`
- 运行数据（配置、日志、会话映射、附件收件箱）都在 `~/.pi/lark/`

## 开发

```bash
npm install
npm test         # node:test 单元测试
npm run typecheck
npm run build    # 刷新 dist/（提交前运行，安装包使用该产物）
```
