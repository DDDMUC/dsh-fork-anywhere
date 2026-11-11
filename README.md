# dsh-fork-anywhere

在 DeepSeek Harness 的会话里从任意位置分叉：产物是一个**独立会话**（不带 `parentSession`），前缀复制到切断点为止。

## 相对官方宿主新增了三个入口

| 入口 | 位置 | 切点 |
| --- | --- | --- |
| 用户消息 | 消息图标行内，紧跟在复制按钮之后 | 该消息自己的事件序号 |
| 压缩点 | 压缩卡片下方的一行（复制 / 分叉 / 用量 / 时间） | `compaction/end` |
| 被停止的轮次 | 该轮内容下方的操作容器内 | 该轮 `turn/end` |

"点哪里，哪里就是尾部"：分叉出的独立会话复制到被点那一行为止，之后的事件一律不带。

## 实现要点

- 压缩行是平台的**会话节点**（`kind: dsh-fork-anywhere-compaction`），由平台按 `anchorSeq = compaction/end + 0.1` 排序，不做 DOM 扫描；
- 用户消息行与"被停止轮次"没有平台插槽，通过 DOM 注入挂载；
- 分叉统一调用宿主 `sessions.fork({ sessionId, atSeq, increaseTitle: true })`，`atSeq` 原样传递；
- 分叉出的会话里，只有**从用户消息分叉**时才会隐藏空的收尾轮（`turn/end` 的 reason 为 `forked`）；从压缩点分叉时不动任何 DOM。

## 安装

```bash
pnpm add dsh-fork-anywhere
```

然后在 profile 的 `dsh.profile.bundles` 里加入 `dsh-fork-anywhere`，重启应用。

## 开发

```bash
npm run check   # 语法 + 单元测试
```

客户端半区（`src/client.js`）在页面加载时被宿主缓存，改动需要完整重启应用才生效。

## License

MIT
