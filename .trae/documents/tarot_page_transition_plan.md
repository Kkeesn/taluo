# 塔罗豆包风双页交互 · Implementation Plan

## 仓库调研结论

### 现状
- 当前架构：单页面 `templates/index.html` + `static/js/app.js`（状态机 + 抽牌按钮）+ `static/css/app.css`（牌阵布局）+ Flask `app.py`（`scan_cards`、牌库 `/api/config`、`POST /api/interpret` SSE 流式，带 `Z1 <think>` 去标签）。
- 牌库：`card/**/*.jpeg` 共 78 张，从文件名 stem 推导 `arcana`（Major = `"Major"` 目录，其他 Minor）和 `suit`（圣杯/权杖/宝剑/星币）。已有完整 `/static/card/<path:rel>` 路由，保持不变。
- 牌阵：5 种在 `app.py` 的 `SPREADS` 数组里（`yesno(1) / time3(3) / triangle(3) / cross5(5) / celtic7(7)`）。**位置含义沿用**。
- 模型：4 种在 `MODELS` 里，`id` 是真实智谱模型名（`glm-4-flash-250414 / glm-4.6v-flash / glm-4.7-flash / glm-z1-flash`）。后端用这些真实 id 调 API，不允许改。
- SSE 解读接口：`POST /api/interpret` 参数 `spread_id / model_id / question / positions / cards:[{name,upright,position}]`。返回 `data: {"ok":true,text:"…"}` + `{"ok":true,done:true}`；错误走 `data: {"ok":false,error:"…"}`。**保持后端契约不动。**

### 用户需求明确化（结合 4 选项问答 + 网上查的真实塔罗抽牌规则）
1. **Page1**（居中豆包风对话卡片）：问题输入（居中）→ 选模型（下拉，**显示名用古神拟人名**，真实 `id` 作 option value 保留）→ 选牌阵（5 个卡片列表）→ 底部「🧘 意念集中」按钮。
2. **过渡**：点击「意念集中」后，Page1 覆盖全屏 **向内汇聚粒子** + **收缩同心圆**（2.6s），结束后 `window.scrollTo(0,0)` 过渡到 Page2。
3. **Page2 抽牌**：上半=进度指示（"第 N / 总数 张 · 从大阿尔卡那选 1 张"），下半=**扇形展开**（当前位置对应的牌库子集：大阿尔卡那 22 / 小阿尔卡那 56 / 整副 78），用户点一张 = 3D 翻牌 + 飞入左侧对应卡槽；抽完自动切下一位置直到完成。
4. **每张从哪副抽（按真实塔罗流派规则）**：
   - YesNo 1 张：整幅（yes/no 流派公认 78 张）。
   - 时间流 3 张：过去=整幅，现在=整幅，**未来=大阿尔卡那**（经典初学者简化推荐大阿尔卡那 22 看时间结果）。
   - 圣三角 3 张：现状/挑战=整幅，**建议=大阿尔卡那**（圣三角终位按"数字占卜法"只用大秘仪）。
   - 小十字 5 张：心/根/果=大阿尔卡那；**面/枝=小阿尔卡那**（现实层面+环境层面用日常小阿卡那）。
   - 简化凯尔特十字 7 张：①局面 / ②挑战 / ③根源 / ⑦最终结果 = **大阿尔卡那**；（传统凯尔特十字"古代凯尔特"经典版只用 22 大秘仪抽前 7 张）；④过去 / ⑤未来 / ⑥外部环境 = **整幅**（近期事件与外部用整副，含小阿卡那具体事件）。
5. **Page3（Page2 抽完后的右栏）**：左列 = 竖列牌卡缩略图（正逆徽章 + 位置名，点击 → 模态大图浮层查看真图）；右栏 = 先出现 `WAITING_STEPS`（感应牌意/典籍/因果/组织语言/个性化拆解）等待动效，然后 SSE 流式按 **每张牌分卡解读**（不是整篇长文，系统 prompt 增加「按位置输出`## 位置N：标题` 分隔块」，前端按 `## ` 切片 append 到该卡的折叠面板，或一整列时间轴样式渲染；如果模型一次性连续输出多张、前端切不到分隔符，就 fallback 全渲染为总览块——保证接口契约不换）。
6. **模型拟人名**（用户选古神风）：
   - `glm-4-flash-250414` → **xx者 阿伽（Agha）**（闪速应答）重新取名
   - `glm-4.6v-flash`     → **叙梦者 薇菈（Vera）**（均衡叙事）
   - `glm-4.7-flash`      → **慢语者 默里斯（Morris）**（深度长文）
   - `glm-z1-flash`       → **演算师 绮莉丝（Kiris）**（推理快）
7. 保留旧 `app.py` 的 **后端 API、SPREADS 真实 position 字段、牌库扫描、SSE 反缓存头、AbortController 机制**——只把 `MODELS` 多一个前端展示字段 `alias`（不影响后端真实 id 调用）。

### 从搜索结论确定的抽牌规则出处
- Yes/No 整幅 78：Uranize Yes/No Guide "Step 2 Shuffle and Draw One Card — full deck."
- 时间流 3 结果位用大阿尔卡那：Satyori 3-card Guide "Working with Major Arcana" 建议初学者/未来趋势位用大 22。
- 圣三角传统可用大秘仪：Doc88 塔罗牌排阵百科 "圣三角占卜法 适用于 22 大秘仪/56 小秘仪/78 全"；建议位用大。
- 凯尔特十字原版 1-6 用 22 大阿尔卡那：Baike 百科 "1.将22张大阿尔克那置于桌面洗牌…位置1~6牌面朝上"（简化 7 张版把 1、2、3、7 保留大、其余全幅）。
- 洗牌流程选牌方式：fateflows 流程 "4. 扇面展开直觉抽取"。

## 文件与模块改动（影响面：4 个文件，后端只加 4 个前端 alias 字段不动接口契约）

| 文件 | 改动 |
|---|---|
| `d:\liuwp\program\taluo\app.py` | `MODELS` 每项加 `alias`（古神拟人名）+ `personality` 一句话性格；`SPREADS.positions[i]` 每项加字段 `pickFrom: "Major" \| "Minor" \| "Full"`；**不改任何路由、不改接口参数、不改 SSE 格式**。`/api/config` 输出里自然把这些字段带给前端。 |
| `d:\liuwp\program\taluo\templates\index.html` | 删掉旧的三栏结构（左表单 / 中卡牌 / 右解读）。新结构：`body` 下 `#stage`，包含：① `<section id="page-setup">`（居中豆包风对话框：问题大 textarea、模型下拉 card、牌阵卡片列表、意念集中按钮 + 字符计数）；② `<div id="transition-overlay"><canvas id="fx-canvas"></canvas><div class="rings"><div class="ring r1"></div>…</div></div>`（隐藏态）；③ `<section id="page-pick" hidden>`（左=空卡槽列表 `#pick-slots`，右=位置标题 + 库切换 chip（只读，按 pickFrom 决定高亮大/小/整幅）+ 扇面容器 `#fan-container`，抽完显示「📜 开始解读」按钮或直接触发）；④ `<section id="page-read" hidden>`（左 `#thumbs` 竖向缩略卡，右 `#interpretation` 包含等待/流式文本，顶栏显示牌阵+拟人名模型）。页脚不回归，保持无页脚。 |
| `d:\liuwp\program\taluo\static\css\app.css` | **彻底重写**，保留旧的 CSS 变量（暗紫 + 金 gradient、radius、card meta、reversed img rotate 180°、primary-btn 样式、waiting-banner 五段动画），新增：`.setup-card` 居中玻璃态 600-720px 宽对话框；`#transition-overlay` 固定全屏 + canvas/环 `@keyframes contractRing`（scale 1→0 opacity 1→0）；`.fan-container > .fan-card` 每个 `--i` 决定扇形角度 `rotate(var(--angle)) translateY(var(--r))`、hover 放大+亮度；`.pick-slot` 空槽占位（翻牌飞入用 transform 终点=slot.getBoundingClientRect）；模态 `.card-modal` 全屏黑幕+大图+位置解读；`.reading-layout` grid `1fr 1.3fr`（左缩略图 右解读）。 |
| `d:\liuwp\program\taluo\static\js\app.js` | **重写状态机**：`state.phase ∈ {setup,transition,picking,reading}` + `spreadId / modelId / question / picks[{posIdx,card,upright,pickFrom}] / currPosIdx / abortCtrl / readingId`；抽牌阶段 `renderFan(positions[currPosIdx].pickFrom)` 按大/小/整幅过滤 `state.cards`；点击 fan-card → 正/逆随机（50%）→ 用 `Web Animations API animate(transform, {duration:620, easing:"ease-in-out"}` 飞入左槽；全部抽完 → 「开始解读」→ 复用原有 `teardownPreviousReading / onRead SSE 主循环` 但输出改按 `## ` split 或时间轴分卡渲染；左缩略卡 `click → modal.show(img-src=card.image+upright)`。过渡动画：canvas 粒子（120 个 `[x,y,vx,vy,color,r]`，每帧 `x += vx; vx *= 0.97;` 向中心收敛 2.6s）+ 4 条 `div.rings` CSS `contractRing` 延迟 0/0.15/0.3/0.45s。 |

## 实现步骤（依赖序）

1. **后端字段追加（无接口破坏，最小改动）**：在 `app.py` 给 `MODELS` 每项补 `alias/personality`；给 `SPREADS.positions[i]` 补 `pickFrom`（按上一节"每张从哪副抽"表格一一写入 1+3+3+5+7=19 个位置）。重跑 `/api/config` 单测（curl），确认字段存在、旧字段不缺。
2. **HTML 三页骨架替换**：`index.html` 删掉 `cards-panel / spread-grid / model-select / question / draw-btn / reset-btn / reading / status` 原 DOM，换成上表格 `page-setup / transition-overlay / page-pick / page-read` 四段结构；`/healthz` 不引用它们所以不需改。
3. **CSS 大改**：保留 CSS vars、reversed img、primary-btn gold gradient、waiting-steps 5 步动画类（`.waiting-steps / .step.active / .step.done / miniPulse / crystalFloat / bookWave / sparkleFloat`）。重写 `.setup-card`（豆包风：圆角 28、毛玻璃 backdrop-blur、input 大字号）；`#transition-overlay position:fixed inset:0 pointer-events:none z-index:9999 display:none`，show 时 `display:block` 再动画；`#page-pick` grid `.picking-layout 320px minmax(0,1fr)`；`.fan-card` CSS 变量扇形排布；`.card-modal` 点击缩略图触发。
4. **JS 重写**：保留既有 `renderWaitingBanner / transitionToStreaming / teardownPreviousReading / setStatus / shuffle` 5 个函数签名（内部可小改）；新写 `renderSetup / onStartFocus / startTransition / renderFan / pickCard / animateFlyToSlot / renderSlots / onCardThumbClick / splitAndRenderSections`。抽牌"每张不能重复"：已选卡 `name` 从 fan 候选列表过滤（即使整幅→大阿尔卡那切换，也不重复）。
5. **SSE 文本按卡切片渲染**：后端 `SYSTEM_PROMPT` 在"分段落加小标题"之后追加一句 `每个位置输出必须以 Markdown 标题行 "## N. 位置名（牌名 正/逆位）" 开头，并把该位置的牌义严格写在自己的标题段里，不要混写。`。前端新增 `sectionRenderers: Map<posIdx, HTMLElement>`，遇到 `^## \d+\.` 行就切换当前 append 容器（该缩略卡右侧面板）；之前还没遇到任何 `##` 的归到「总体结论」头块。解析失败就 fallback 追加到右栏总容器，避免白屏。
6. **本地联调**：`uv run python app.py` → 浏览器 F5 → /healthz 200 → 选 yesno 输入问题点意念集中看过渡动画 → 整幅扇形 78 抽 1 → 解读流式出来且有 ## 切分；再跑一遍 celtic7 验证大阿尔卡那 4 位置 + 整幅 3 位置 切换 fan。
7. **Zeabur 兼容确认**：不改 Procfile，不改 requirements（CSS/JS 纯静态、粒子用 Canvas 2D 浏览器原生）。

## 依赖与注意事项
- **模型真实 `id` 与 `alias` 分离**：前端 `option.value = id`（glm-…），显示文本用 `alias`（快语者阿伽…）；`onRead` 请求里 `model_id` 必须传真实 id、不是 alias，否则智谱 404。
- **牌名重复保护**：如果用户跨位置抽到同名（虽然后端校验会失败 "牌库中找不到：愚人?" 但这里是前端主动拦截，`state.picks.map(p=>p.card.name)` 放进 `Set`，fan 渲染时 `filter(c=>!used.has(c.name))`）。
- **正逆位**：在扇面**点下去的时候**决定 50% upright / 50% reversed，和旧版逻辑一致，不要默认全正位。
- **粒子性能**：120 粒子 + 每扇最多 78 张 DOM（78 绝对定位），移动端 ≤ 560px 走 fallback：粒子降到 60，扇形退化为网格（`repeat(auto-fit, minmax(100px,1fr))`），不用 transform rotate 扇形。
- **浏览器兼容性**：`Web Animations API animate()` 在所有目标移动端 iOS14+/Android Chrome 80+ 都 ok；不写任何 ES2020+ 私有字段或 `??=`。

## 验证
1. `/healthz` → `cards:78`、`/api/config` 每项 `positions[i]` 含 `pickFrom`，`models[i]` 含 `alias`。
2. Page1 表单校验：问题 <2 字 不允许点意念集中；模型/牌阵都有默认。
3. 过渡动画 2.6s 后：Page2 第一张要抽的位置高亮 → fan 从底部展开 → 点一张飞入左槽（正逆徽章正确）→ 切下一张位置标题（显示"大阿尔卡那 / 小阿尔卡那 / 整幅"标签）→ 抽完后右栏先 5 步等待文案旋转 → SSE 首字节 → 分段 `##` 标题进入对应卡片面板。
4. **点击左缩略图**：弹模态大图（逆位图 180°）。
5. **中途取消**：重开 Page1 或「重来」→ `abortCtrl.abort()` + readingId++ 正常，无红错字。
6. **抽错想重抽**：每个槽右上角有 `×` 点掉回扇面重新抽（该位置重开 fan，其他位置已抽保留）。
7. Grep 全文：无旧的 `deck-slot / deck-left / spread-grid / cards-panel` 残留。

## 风险
| 风险 | 处理 |
|---|---|
| 大改三文件后「抽了牌显示请先抽牌」同类 DOM 重建时序错 | 严格按"先渲染结构 → 再改按钮 disabled"的套路，且所有按钮走单一渲染函数 `renderCTA({phase,picksLeft,readingState})` |
| 模型 `alias` 误传给智谱 API → 404 | 前端 `state.modelId` 永远存真实 `id`，`alias` 只读；后端 `next((m for m in MODELS if m.id==model_id),None)` 校验仍保留（本来就有） |
| Fan 78 张 + 粒子 120 低端安卓卡顿 | CSS `@media(max-width:560px)` 把 fan 降级为网格，粒子数 / 半径缩半 |
| `##` 标题切分失败（模型不按指令写）→ 文本丢了 | Fallback 策略：收到 `text` chunk **同时**写"总体流文本总容器 + 当前位置容器（若已命中 ## 就写，否则也写总容器保证不丢）"——最多重复但不漏 |
| 翻牌飞入动画结束后 DOM 残留飞卡 | animate `fill:"forwards"` + onfinish `remove()`，slot 里用独立 DOM（不跟 fan 中同一张节点复用） |
