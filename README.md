# dsh-system-monitor

Composer dock monitor for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Replaces the default composer usage/activity pills and context meter with 5 monochrome, drag-reorderable pills in `conversation.composer.dock`: **Context**, **Tokens**, **CPU**, **GPU**, and **MEM**.

DeepSeek Harness (`dsh`) 输入框底栏系统与会话监控插件。在 `conversation.composer.dock` 槽位提供 **Context**、**Tokens**、**CPU**、**GPU**、**MEM** 五枚可拖拽吸附重排的单色胶囊，点击任意胶囊按三次贝塞尔曲线展开详情卡片。

## Features / 功能特性

- **Context Pill & Card**:
  - Pill shows a `5×3` column-major brick micro-grid and context occupancy percentage.
  - Card expands into a `20×5` (`100`-cell, `277×67px`) 3-color brick matrix breaking down `systemTokens`, `toolsTokens` (guaranteed at least 1 cell), and `messageTokens`.
- **Tokens Pill & Card**:
  - Displays current-turn net upload or streaming download tokens with a rotating directional arrow during active turns, and total conversation context tokens when idle.
  - Deduplicates multi-step prompt history (`stepNetUp = max(0, P_k - (P_{k-1} + O_{k-1}))`) and renders up to 16 step bars plus prompt cache hit rate.
- **CPU / GPU / MEM Pills & Cards**:
  - Host plugin compiles a zero-dependency Mach & IOKit C sampler (`sampler.c`) on first subscription, streaming frames every `200ms` (`5Hz`) over `POST /system-monitor/stream` and stopping `5s` after the last subscriber disconnects.
  - Falls back to `top`/`ioreg` or `node:os` when `clang` is unavailable or on non-macOS hosts.
  - Cards display a 60-second scrolling bar chart, 60-second peak line, breakdown metrics, and top 5 processes by CPU or memory (`POST /system-monitor/processes`).
- **Single Unified Clock (`1000ms`)**:
  - A single `unifiedClock` mounted on one `requestAnimationFrame` loop drives all 5 pills and open cards without `setInterval`, updating numeric readings once per second while interpolating bar scrolling and growth across the full `1000ms` clock cycle.
- **Slot-Grid Drag & Drop**:
  - Drag any pill to reorder across the 5 dock slots with live dodging, opaque drag surface, cubic-bezier snap, and `localStorage` persistence.

## Install / 安装

```sh
dsh plugin --profile web add github:Shiro-umi/dsh-system-monitor
```

Or install from the release tarball:

```sh
dsh plugin --profile web add https://github.com/Shiro-umi/dsh-system-monitor/releases/latest/download/dsh-system-monitor.tgz
```

## License

MIT
