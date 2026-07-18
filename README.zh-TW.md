<div align="center">

<img src="docs/images/canvai-demo.gif" alt="canvai — agent 在你眼前即時把規劃畫上板" width="820">

# canvai

**為你和你的 agent 打造的白板。** 說出你在想什麼——你的 coding agent 就把它畫成一張共享畫布：卡片、連線、圖表，並跟你一起即時重塑它。

[![GitHub stars](https://img.shields.io/github/stars/chuck00lin/canvai?style=for-the-badge)](https://github.com/chuck00lin/canvai/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/chuck00lin/canvai?style=for-the-badge)](https://github.com/chuck00lin/canvai/network/members)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

English → **[README.md](README.md)**

</div>

板子就是 repo 裡的 [JSON Canvas](https://jsoncanvas.org) 純文字檔，跟程式碼一起被 git 版控。把 canvai 丟進任何專案、把 [Claude Code](https://claude.com/claude-code)（或任何 MCP client）指過去，就能在瀏覽器裡討論，而不是在 terminal——不需要設計工具、不需要帳號、不需要 Obsidian。

```bash
cd /path/to/your/project
npx @chuck00lin/canvai init      # 接進來——寫 .mcp.json + Claude Code 預核准
npx @chuck00lin/canvai serve     # → http://127.0.0.1:5199
```

就這樣——不用 clone、不用 build。需要 **Node 18+**。常用的話 `npm i -g @chuck00lin/canvai`，之後直接用 `canvai`。

> **現在就能用：** 整個人↔agent 閉環現在就跑得起來——把 canvai 接到任何 repo、在瀏覽器打開板，Claude Code 就即時在上面編輯、你同時拖卡片回應它（MCP hub＋canvas 函式庫＋React Flow client，watcher→WebSocket）。板的*協定*仍在收斂，我們正收集真實情境再凍結它。**曾希望能跟 agent 在白板上而不是滑 terminal 討論架構？[告訴我們你的情境](.github/ISSUE_TEMPLATE/use-case.yml)**——早期需求最能形塑這專案。

## 為什麼是 canvai

Terminal 對視覺化思考者是一條太窄的管道——而今天它是我們跟 agent 唯一共享的管道。canvai 讓你和一個 AI 夥伴共享一張無限畫布：你用拖拉與分組做空間思考，agent 讀*整張板*、跟你一起重塑它。像 Miro 或 FigJam，但參與者包含 AI agent——而檔案就是 repo 裡的 JSON Canvas，你的思考仍屬於你。

## 亮點

### 🧑‍🤝‍🤖 一張板，兩種參與者
把想法丟成卡片、連起來、把問題的形狀畫出來。Agent 讀整張板、就地回應、跟你一起重塑——是真正的共享畫面，不是「聊天記錄配一張圖」。

### 🧠 Agent 說結構，不說像素
Agent 用 MCP 語意操作（`add_node`、`connect`、`insert_mermaid`…），讀「去座標的結構投影」。[ELK](https://eclipse.dev/elk/) auto-layout 把結構翻成座標，agent 專注在意義、畫布負責空間。

### 📄 你的板子就是 repo 裡的檔案
每張板是 `discuss/` 底下的 [JSON Canvas](https://jsoncanvas.org) 檔，git 版控、是唯一真相。沒有東西被鎖在雲端——clone repo，你的思考就跟著走。

### 📌 人類意圖優先
任何你拖過的卡片會被 **pin 住**：`auto_layout` 繞開它，agent 在下次讀取時接手你的排版。你排版，agent 配合。

### 🧜 Mermaid 進、canvas 出
Agent 可以輸出 Mermaid，hub 把它爆開成真正的 canvas 節點（parse → layout → nodes）。密集結構圖（sequence、state）以 fenced block 在卡片內原地渲染。Mermaid 是 I/O 語言，不是儲存格式。

### 🪟 Obsidian 可有可無
Web client 就是完整 UI——不用再裝別的。但因為板子就是 JSON Canvas 檔，若你已用 [Obsidian](https://obsidian.md)，把 repo 當 vault 打開就能原生渲染與編輯。

### 🌐 到哪都能跑——沒 VPN 也行
預設本機。加 `--host 0.0.0.0 --token` 走 LAN/VPN，或用 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) tunnel 拿一個公開 HTTPS 網址、免 port-forward。可選的 `--report-url` 遙測會在早期把遠端 install 的 crash/error 回報給你。見 **[docs/deploy.md](docs/deploy.md)**。

## 開始使用

**接進來**——在你想放板的 repo 裡：

```bash
cd /path/to/your/project
npx @chuck00lin/canvai init
```

這會把 `canvai` MCP server 寫進 `.mcp.json` 並替 Claude Code 預核准。*（想從原始碼跑或要貢獻？`git clone` + `node scripts/setup.mjs --repo .` 效果相同——見 [docs/deploy.md](docs/deploy.md)。）*

**打開畫布：**

```bash
npx @chuck00lin/canvai serve --root . --autocommit   # → http://127.0.0.1:5199
```

**一起想**——叫 Claude Code *「建一張板 `discuss/architecture.canvas`、設為 active、把我們的模組結構畫上去」*，卡片就會隨它工作出現在瀏覽器。拖一張卡它就 **pin 住**——`auto_layout` 繞開它、agent 下次讀取接手你的排版。雙擊編輯 markdown（` ```mermaid ` fence 會渲染成圖）、從側邊 handle 拉線、勾選一張板為 **active** 把 agent 指過去。側邊 chat 裡，**Send** 問 agent；**Note** 只在板上記一筆。

## 核心想法

- **持久層是 position-first**：`discuss/*.canvas`（JSON Canvas 1.0）放在你的 repo 裡，人類的拖拉永遠有地方落地——Obsidian 還能免費原生開啟。
- **Agent 介面是 structure-first**：agent 用 MCP 語意操作、讀「去座標的結構投影」；ELK 把結構翻成座標。**Agent 從頭到尾不需要思考像素。**
- **人類意圖優先**：被人拖過的節點會 pin 住，auto-layout 繞開它。
- **Mermaid 是 I/O 語言，不是儲存格式**：agent 輸出 mermaid，hub 爆開成 canvas 節點；密集圖在卡片內原地渲染。

架構圖與完整決策理由（含「為什麼不做 mermaid 互動引擎」「為什麼 Obsidian 只當 client 不當 server」）請見英文版 [README](README.md) 與[設計文件](docs/design.md)。

## 參與

現階段最有價值的貢獻是**使用情境**：你是誰、板上會放什麼、希望 agent 在上面做什麼。歡迎[開一個 use-case issue](.github/ISSUE_TEMPLATE/use-case.yml)，或直接挑戰[設計文件](docs/design.md)裡的任何決策。

## 授權

[MIT](LICENSE)
