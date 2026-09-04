# -*- coding: utf-8 -*-
"""
塔罗解读 Web 应用 (Zeabur 可部署)
- Flask 后端: 静态托管 + /api/config(牌阵/模型选项) + /api/interpret(SSE流式调用智谱)
- API Key: 读环境变量 ZHIPU_API_KEY (Zeabur后台配置)
"""
from __future__ import annotations

import glob
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Dict, List

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_from_directory, stream_with_context
from openai import OpenAI

load_dotenv()

ROOT = Path(__file__).resolve().parent
CARD_DIR = ROOT / "card"
STATIC_DIR = ROOT / "static"
TEMPLATE_DIR = ROOT / "templates"

# ============= 牌库: 扫描 card 目录 =============
def scan_cards() -> List[Dict]:
    """扫描 card/**/*.jpeg，构建牌列表，中文名 -> 相对路径"""
    cards: List[Dict] = []
    for p in sorted(glob.glob(str(CARD_DIR / "**" / "*.jpeg"), recursive=True)):
        rel = os.path.relpath(p, CARD_DIR).replace("\\", "/")  # e.g. "Major/愚者.jpeg"
        name = Path(rel).stem                               # e.g. "愚者"
        suit_dir = rel.split("/")[0] if "/" in rel else ""
        suit = suit_dir if suit_dir in ("Major",) else {
            "cups": "圣杯", "wands": "权杖", "swords": "宝剑", "pentacles": "星币",
        }.get(suit_dir, suit_dir)
        cards.append({
            "name": name,
            "image": rel,                 # 前端直接拼 <img src="/static/card/{image}">
            "suit": suit,
            "arcana": "Major" if suit_dir == "Major" else "Minor",
        })
    return cards


CARDS: List[Dict] = scan_cards()
CARDS_BY_NAME: Dict[str, Dict] = {c["name"]: c for c in CARDS}
print(f"[init] 扫描牌库: {len(CARDS)} 张")

# ============= 牌阵配置 =============
SPREADS = [
    {
        "id": "yesno",
        "name": "单张 Yes/No",
        "count": 1,
        "desc": "快速一问一答，用一张牌给出明确倾向与理由。",
        "positions": [
            {"label": "答案", "hint": "核心倾向与依据", "pickFrom": "Full"},
        ],
    },
    {
        "id": "time3",
        "name": "三张 · 时间流 (过去/现在/未来)",
        "count": 3,
        "desc": "最经典的时序牌阵，按时间线展开解读因果走向。",
        "positions": [
            {"label": "过去", "hint": "起因、背景、业力与惯性", "pickFrom": "Full"},
            {"label": "现在", "hint": "当前能量、关键局面与你的状态", "pickFrom": "Full"},
            {"label": "未来", "hint": "按当下惯性发展可能得到的结果", "pickFrom": "Major"},
        ],
    },
    {
        "id": "triangle",
        "name": "三张 · 圣三角 (现状/挑战/建议)",
        "count": 3,
        "desc": "问题 → 困难 → 破局路径，适合行动抉择。",
        "positions": [
            {"label": "现状", "hint": "问题所处的总体局面", "pickFrom": "Full"},
            {"label": "挑战", "hint": "你当下最大的阻力或盲区", "pickFrom": "Full"},
            {"label": "建议", "hint": "可执行的下一步行动方向", "pickFrom": "Major"},
        ],
    },
    {
        "id": "cross5",
        "name": "五张 · 小十字 (心/面/根/枝/果)",
        "count": 5,
        "desc": "由心到果的五维剖析，适合复杂关系或选择。",
        "positions": [
            {"label": "核心 (心)", "hint": "问题的本质与你的内心", "pickFrom": "Major"},
            {"label": "现状 (面)", "hint": "外在客观表现与可观察事实", "pickFrom": "Minor"},
            {"label": "根源 (根)", "hint": "导致现状的深层原因", "pickFrom": "Major"},
            {"label": "影响 (枝)", "hint": "相关人物、事件与环境因素", "pickFrom": "Minor"},
            {"label": "结果 (果)", "hint": "最终走向或建议结论", "pickFrom": "Major"},
        ],
    },
    {
        "id": "celtic7",
        "name": "七张 · 简化凯尔特十字",
        "count": 7,
        "desc": "覆盖现状、挑战、过去、未来、建议、外部、结果。",
        "positions": [
            {"label": "① 当前局面", "hint": "问题核心现况", "pickFrom": "Major"},
            {"label": "② 挑战/跨越", "hint": "横在面前的障碍或助力", "pickFrom": "Major"},
            {"label": "③ 潜意识根源", "hint": "未察觉的深层动因", "pickFrom": "Major"},
            {"label": "④ 近期过去", "hint": "对现在仍有影响的最近发生", "pickFrom": "Full"},
            {"label": "⑤ 近期未来", "hint": "接下来的短期走向", "pickFrom": "Full"},
            {"label": "⑥ 外部环境/他人", "hint": "关系他人与环境能量", "pickFrom": "Full"},
            {"label": "⑦ 最终结果", "hint": "综合能量的最终落点", "pickFrom": "Major"},
        ],
    },
]

# ============= 模型选项 =============
# 注意：id 必须是智谱真实模型名（后端调 API 用）；alias/personality 仅前端拟人名展示用。
MODELS = [
    {"id": "glm-4-flash-250414",   "name": "GLM-4-Flash (快 · 稳定)", "speed": "极快", "pick": "推荐日常",
     "alias": "快语者 · 阿伽",  "personality": "话快、准、稳，擅长日常问答秒出结论。"},
    {"id": "glm-4.6v-flash",       "name": "GLM-4.6V-Flash (均衡)",    "speed": "快",   "pick": "综合首选",
     "alias": "叙梦者 · 薇菈",  "personality": "温柔而理性，最会把牌意编织成故事般的解读。"},
    {"id": "glm-4.7-flash",        "name": "GLM-4.7-Flash (强 · 长)",   "speed": "慢",   "pick": "深度解读",
     "alias": "慢语者 · 默里斯", "personality": "慢吞吞但字字珠玑，深度长文与复杂牌阵的专家。"},
    {"id": "glm-z1-flash",         "name": "GLM-Z1-Flash (推理最快)",   "speed": "极快", "pick": "专业分析",
     "alias": "演算师 · 绮莉丝", "personality": "推理速度极快，擅长拆解因果逻辑与内在联系。"},
]


# ============= 后端初始化 =============
# 静态资源两条挂载:
#   /static/css/*, /static/js/*  -> static/ 目录 (Flask内置)
#   /static/card/*              -> card/   目录 (自定义路由, 牌图不用挪动位置)
app = Flask(
    __name__,
    static_folder=str(STATIC_DIR),
    static_url_path="/static",
    template_folder=str(TEMPLATE_DIR),
)


# ============================================================================
# 全局响应钩子：移除所有违规的 hop-by-hop（逐跳）响应头
#   - WSGI(PEP3333) + CloudBase/Zeabur 等反向代理环境，Connection/Transfer-Encoding
#     这类 Header 只能由最外层网关输出，应用层手动设置会被代理判违规 → 500 / 截断响应。
#   - 一劳永逸：不管以后哪里再手滑加上去，这里统一剥掉。
# ============================================================================
@app.after_request
def remove_hop_by_hop_headers(response):
    hop_by_hop = {
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade",
    }
    for h in list(response.headers.keys()):
        if h.lower() in hop_by_hop:
            del response.headers[h]
    return response


@app.get("/static/card/<path:rel>")
def serve_card(rel: str):
    """牌图资源: card/ 里的 jpeg 直接 serve"""
    safe = rel.replace("\\", "/").lstrip("/")
    return send_from_directory(str(CARD_DIR), safe)


@app.get("/")
def index():
    # 手机端浏览器（尤其是微信内嵌 WebView / iOS Safari 老版）遇到缺 charset 的 text/html
    # 有时会按 application/octet-stream 误判 → 触发"下载一个 html 文件"。
    # content_type= 是 Werkzeug 官方推荐的唯一入口（比 headers={"Content-Type":…} 更稳），
    # 再加 nosniff 禁止任何中间层做 MIME 嗅探改写。
    html = render_template("index.html")
    resp = Response(html, content_type="text/html; charset=utf-8")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@app.get("/healthz")
def healthz():
    resp = jsonify({
        "ok": True,
        "cards": len(CARDS),
        "has_key": bool(os.getenv("ZHIPU_API_KEY")),
    })
    resp.content_type = "application/json; charset=utf-8"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@app.get("/api/config")
def api_config():
    """前端启动时拉取: 模型列表 + 牌阵列表 + 牌库(可以用来前端洗牌)"""
    resp = jsonify({
        "cards": CARDS,
        "spreads": SPREADS,
        "models": MODELS,
    })
    resp.content_type = "application/json; charset=utf-8"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ============= 解读接口 =============
SYSTEM_PROMPT = (
    "你是专业塔罗解读师，风格温和理性，富有同理心但不制造焦虑。"
    "【必读规则】1. 开头必须写一行：【塔罗仅为心理隐喻娱乐，不可作为重大决策依据】。"
    "2. 严格依据用户提供的牌阵和每张牌的位置（正位/逆位）进行解读，不要凭空换牌或添加未抽到的牌。"
    "3. 解读结构必须严格按位置分段，每一个位置的解读**必须且只能**以 Markdown 二级标题行开头，"
    "标题格式固定为：「## N. 位置名（牌名·正位/逆位）」，"
    "其中 N 是从 1 开始的位置序号（严格对应所给 positions 顺序），位置名、牌名与正逆位都必须照抄用户提供的原文，不要错字漏字，不要自改。"
    "每个位置标题之后的正文，**只写该位置**对应的牌义、该位置与问题的关联分析，严禁混入其他位置的内容。"
    "在最后一张牌的解读段之后，再写一个不带编号的总结段，标题行使用：「## 总体结论 · 关系呼应 · 行动建议 · 温暖鼓励」，"
    "正文必须覆盖四件事：① 牌与牌之间的关系与内在呼应（谁助推谁、谁是冲突点）；"
    "② 具体可执行的行动建议（至少 2 条，要可落地不虚空）；③ 一句话温暖鼓励；"
    "④ 若是 Yes/No 牌阵，在总体结论开头第一句必须**明确写出**：「【倾向】是/否/中性」三选一，再给理由和结论。"
    "4. 语言简洁分段落、中文表达自然，不要堆比喻不要冗长，不要使用 HTML、不要在标题之外再写编号序号。"
    "5. 除了上面规定的「## …」标题行，不要出现任何其他以 # 号开头的行，也不要省略或合并任何一个位置的标题段落。"
)


def build_user_prompt(question: str, spread_name: str, positions: List[Dict], cards: List[Dict]) -> str:
    head = (
        f"我想问的问题：{question.strip()}\n"
        f"牌阵：{spread_name}（共 {len(cards)} 张）\n"
        f"抽到的牌（按顺序，正位/逆位随机，你按「方向」解释）：\n"
    )
    body_lines = []
    for i, (pos, card) in enumerate(zip(positions, cards), 1):
        body_lines.append(
            f"  {i}.【{pos['label']}】 — {card['name']} "
            f"({'正位' if card.get('upright', True) else '逆位'})"
            f"   位置含义: {pos.get('hint','')}"
        )
    tail = "\n请你严格按系统提示的结构解读。"
    return head + "\n".join(body_lines) + tail


def _sse_error(msg: str):
    """构造 SSE 格式的错误流（立刻 yield 1 条错误 + 1 条 done）"""
    def gen():
        yield "data: " + json.dumps({"ok": False, "error": msg}, ensure_ascii=False) + "\n\n"
        yield "data: " + json.dumps({"ok": True, "done": True}, ensure_ascii=False) + "\n\n"
    # ⚠ 注意：严禁同时传 mimetype= 和 headers 中的 Content-Type，也不要传 mimetype。
    #   Werkzeug 的 mimetype setter 会覆盖掉带 charset 的 Content-Type，
    #   导致 CloudBase/Zeabur 反向代理判定 SSE 格式违规 → 500。
    return Response(
        stream_with_context(gen()),
        content_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform, must-revalidate, max-age=0",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _sse_ok_headers() -> Dict[str, str]:
    # ⚠ 不要在这里放 Content-Type：统一在 Response(content_type=…) 里设置，
    #   避免和 mimetype= / content_type= 参数冲突导致 charset 丢失。
    return {
        "Cache-Control": "no-cache, no-transform, must-revalidate, max-age=0",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
    }


def _stream_glm(user_msg: str, model_id: str):
    """SSE 流式调用智谱；过滤 Z1 的 <think> 标签。返回 text/event-stream 的 data 行。"""
    api_key = os.getenv("ZHIPU_API_KEY")
    if not api_key:
        yield "data: " + json.dumps({"ok": False, "error": "未配置 ZHIPU_API_KEY，请到 Zeabur 后台配置环境变量"}, ensure_ascii=False) + "\n\n"
        return

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        timeout=240.0,
    )

    try:
        stream = client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_msg},
            ],
            temperature=float(os.getenv("ZHIPU_TEMPERATURE", "0.85")),
            stream=True,
        )
    except Exception as e:  # noqa: BLE001
        yield "data: " + json.dumps({"ok": False, "error": f"API 调用失败: {type(e).__name__}: {e}"}, ensure_ascii=False) + "\n\n"
        return

    # ---- Z1 <think> 段剥除（重写为更稳的索引搜索，避免 re non-greedy 在跨 delta 时错过）----
    buf = ""
    OPEN = "<think"
    CLOSE = "</think>"

    def strip_complete(buf: str):
        # 重复剥离所有完整 <thinkX>…</think>（允许 <think 后有 空格/换行/> 等，直到下一个 > 作为开始边界）
        while True:
            o = buf.find(OPEN)
            if o < 0:
                return buf
            # 找到 open-tag 末尾的 >
            gt = buf.find(">", o + len(OPEN))
            if gt < 0:
                return buf
            c = buf.find(CLOSE, gt + 1)
            if c < 0:
                return buf
            buf = buf[:o] + buf[c + len(CLOSE):]

    for event in stream:
        if not event.choices:
            continue
        delta = event.choices[0].delta or None
        if delta is None:
            continue
        text = delta.content or ""
        if not text:
            continue
        buf += text
        # 先剥除完整闭合的 think 段
        buf = strip_complete(buf)
        # 现在只看：是否残留未闭合的 <think（后面还有 > 但没有 </think>）
        o = buf.find(OPEN)
        if o >= 0 and buf.find(">", o + len(OPEN)) >= 0 and buf.find(CLOSE, o) < 0:
            # 有 open 起始 + open 完成闭合, 但还没有 close → 继续攒
            continue
        # 若存在 "<think" 但后续还没有出现 ">"（跨 delta 切开了 open tag 本身），也继续攒
        if o >= 0 and buf.find(">", o + len(OPEN)) < 0:
            continue
        if buf:
            payload = json.dumps({"ok": True, "text": buf}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
            buf = ""
    # 收尾
    if buf:
        buf = strip_complete(buf)
        # 最后仍有未闭合 think 段 → 只取 <think 之前的文本
        o = buf.find(OPEN)
        if o >= 0:
            buf = buf[:o]
        if buf:
            yield "data: " + json.dumps({"ok": True, "text": buf}, ensure_ascii=False) + "\n\n"
    yield "data: " + json.dumps({"ok": True, "done": True}, ensure_ascii=False) + "\n\n"


@app.post("/api/interpret")
def api_interpret():
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    spread_id = (body.get("spread_id") or "time3").strip()
    model_id = (body.get("model_id") or MODELS[0]["id"]).strip()
    positions_arg: List[Dict] = body.get("positions") or []
    cards_arg: List[Dict] = body.get("cards") or []

    # ---- 校验 ----
    spread = next((s for s in SPREADS if s["id"] == spread_id), None)
    if spread is None:
        return _sse_error(f"未知牌阵: {spread_id}")
    if next((m for m in MODELS if m["id"] == model_id), None) is None:
        return _sse_error(f"未知模型: {model_id}")
    if not question:
        return _sse_error("请输入你想问的问题（至少 2 个字）")
    if len(cards_arg) != spread["count"]:
        return _sse_error(f"牌阵需要 {spread['count']} 张牌，收到 {len(cards_arg)}")
    # 校验每张牌真实存在
    for c in cards_arg:
        if c.get("name") not in CARDS_BY_NAME:
            return _sse_error(f"牌库中找不到: {c.get('name')}")
    positions = positions_arg if len(positions_arg) == spread["count"] else spread["positions"]

    user_msg = build_user_prompt(question, spread["name"], positions, cards_arg)
    print(f"[interpret] spread={spread_id} model={model_id} q={question[:24]} cards={[c['name'] for c in cards_arg]}", flush=True)
    # SSE 流式响应必须：
    # 1) stream_with_context: 保留请求上下文直到生成器耗尽（WSGI/Waitress/Zeabur 需要）
    # 2) content_type 参数显式带 charset（不要用 mimetype=，它会覆盖掉 charset！）
    # 3) 加 headers 禁止任何中间层/代理/nginx buffer，否则前端会看到"一直不输出直到最后一次性吐"
    return Response(
        stream_with_context(_stream_glm(user_msg, model_id)),
        content_type="text/event-stream; charset=utf-8",
        headers=_sse_ok_headers(),
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
