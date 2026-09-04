# taluo - 塔罗解读网页

> GitHub 代码仓库 → Zeabur 一键部署 → 智谱 GLM 大模型做塔罗解读

## 🌐 线上部署 (Zeabur)

1. **GitHub**: 把项目推到你的仓库（如 `https://github.com/Kkeesn/taluo`）
2. **Zeabur**: New Service → Deploy from Git Source → 选仓库
3. **环境变量**（Zeabur 后台 → Service → Variables）：
   ```
   ZHIPU_API_KEY=你的智谱APIKEY
   # 可选:
   ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
   ZHIPU_TEMPERATURE=0.85
   PORT=8080
   ```
4. Zeabur 会自动读取 `requirements.txt` + `Procfile`，启动命令：
   ```
   waitress-serve --port=$PORT --threads=32 app:app
   ```
5. 绑定自定义域名或使用 Zeabur 免费子域名，打开即可使用。

## 🖥️ 本地运行

```powershell
# 首次
uv venv --python 3.12        # 创建虚拟环境
uv pip install -r requirements.txt

# 写 .env
ZHIPU_API_KEY=你的智谱APIKEY

# 启动
uv run python app.py
# 打开 http://localhost:5000
```

## 🎴 功能

- 📱💻 响应式：手机竖屏、电脑横屏均完美适配
- 🧩 5 种牌阵可切换：
  - 单张 Yes/No
  - 三张 · 时间流 过去/现在/未来
  - 三张 · 圣三角 现状/挑战/建议
  - 五张 · 小十字（心/面/根/枝/果）
  - 七张 · 简化凯尔特十字
- 🔀 真实洗牌抽牌（78 张全牌库，不重复，自动正位/逆位）
- 🧠 4 个模型可选（4-Flash / 4.6V-Flash / 4.7-Flash / Z1-Flash）
- ⚡ 解读**流式**展示，不用等 30 秒，逐字跳动

## 🗂️ 目录

```
app.py              Flask 后端 + 扫牌库 + SSE 调 GLM
Procfile            Zeabur 启动命令
requirements.txt    依赖
.env                本地环境变量 (不入库)
card/               78 张牌图 (Major/ + Minor/{cups,wands,swords,pentacles})
templates/
  index.html        单页应用
static/
  css/app.css       样式
  js/app.js         抽牌 + SSE 渲染逻辑
```
