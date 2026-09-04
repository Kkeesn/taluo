# -*- coding: utf-8 -*-
"""
4 个 GLM 系列模型速度 + 回复采集脚本
- 使用 SSE 流式调用, 精确测量: 请求发出 -> 首 token -> 末 token
- 额外记录: 字符数 / 估算 token(字符数//1.8) / 吞吐量 chars/s / prompt_tokens / completion_tokens / usage
- 输出 JSON 文件: benchmark_result.json   (供后续人工质量评估读取)
- 同时控制台打印表格概览
"""

from __future__ import annotations

import json
import re
import time
import os
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

# =========================================================
# 4 个模型配置 (文件来源与模型名一一对应)
# =========================================================
MODELS = [
    {
        "label": "GLM-4-Flash",
        "file":  "glm4.py",
        "model": "glm-4-flash-250414",
    },
    {
        "label": "GLM-4.6V-Flash",
        "file":  "glm46v.py",
        "model": "glm-4.6v-flash",
    },
    {
        "label": "GLM-4.7-Flash",
        "file":  "glm47.py",
        "model": "glm-4.7-flash",
    },
    {
        "label": "GLM-Z1-Flash",
        "file":  "glmz1.py",
        "model": "glm-z1-flash",
    },
]

SYS_PROMPT = (
    "你是塔罗解读助手，风格温和理性，解读开头必须写："
    "【塔罗仅为心理隐喻娱乐，不可作为重大决策依据】，基于抽到的卡牌做解读。"
)
USER_MSG = "我抽到了塔罗的星币3，帮我解读今日运势"
TEMPERATURE = 0.8
OUTPUT_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "benchmark_result.json")


# =========================================================
# 结果结构
# =========================================================
@dataclass
class RunResult:
    label: str
    file: str
    model: str
    ok: bool = False
    error: Optional[str] = None
    # 时间 (秒)
    t_total: float = 0.0          # 从开始请求到接收完整响应
    t_first_token: float = 0.0    # 从开始请求到首个增量内容到达 (TTFT)
    t_generation: float = 0.0     # t_total - t_first_token (纯生成)
    # 文本
    content: str = ""
    chars: int = 0
    chars_no_space: int = 0
    lines: int = 0
    paragraphs: int = 0
    chinese_chars: int = 0
    # token / usage (来自末尾 response.usage)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    # 估算 token (当 usage 缺失时)
    est_completion_tokens: int = 0
    # 吞吐量
    chars_per_sec: float = 0.0
    tokens_per_sec: float = 0.0


# =========================================================
# 单模型流式测速
# =========================================================
def run_one(client: OpenAI, cfg: dict) -> RunResult:
    res = RunResult(label=cfg["label"], file=cfg["file"], model=cfg["model"])
    t0 = time.perf_counter()
    t_first = None
    chunks: List[str] = []
    usage = None
    finish_reason = None

    try:
        stream = client.chat.completions.create(
            model=cfg["model"],
            messages=[
                {"role": "system", "content": SYS_PROMPT},
                {"role": "user",   "content": USER_MSG},
            ],
            temperature=TEMPERATURE,
            stream=True,
            stream_options={"include_usage": True},
        )
        for event in stream:
            # usage 一般在最后一条事件里
            if hasattr(event, "usage") and event.usage is not None:
                usage = event.usage

            if not event.choices:
                continue
            delta = event.choices[0].delta
            if delta is None:
                continue
            text = delta.content or ""
            fr = getattr(event.choices[0], "finish_reason", None)
            if fr is not None:
                finish_reason = fr
            if text:
                if t_first is None:
                    t_first = time.perf_counter()
                chunks.append(text)

        t_end = time.perf_counter()
    except Exception as e:  # noqa: BLE001
        res.error = f"{type(e).__name__}: {e}"
        res.t_total = time.perf_counter() - t0
        return res

    content = "".join(chunks)
    res.ok = True
    res.content = content
    res.t_total = t_end - t0
    res.t_first_token = (t_first - t0) if (t_first is not None) else res.t_total
    res.t_generation = max(0.0, res.t_total - res.t_first_token)
    res.chars = len(content)
    res.chars_no_space = len(re.sub(r"\s+", "", content))
    res.lines = content.count("\n") + 1
    res.paragraphs = len(re.split(r"\n\s*\n", content.strip()))
    res.chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", content))

    # usage 来自 SSE 末尾 (包含 prompt/completion)
    if usage is not None:
        res.prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
        res.completion_tokens = getattr(usage, "completion_tokens", 0) or 0
        res.total_tokens = getattr(usage, "total_tokens", 0) or 0

    # 估算 completion tokens (中文常见 1 token ≈ 1.6~2.0 字符, 取 1.8)
    res.est_completion_tokens = max(1, int(res.chars_no_space / 1.8))

    # 吞吐量
    gen_t = max(1e-6, res.t_generation)
    res.chars_per_sec = res.chars_no_space / gen_t
    tok = res.completion_tokens if res.completion_tokens > 0 else res.est_completion_tokens
    res.tokens_per_sec = tok / gen_t

    if finish_reason:
        res.error = f"finish_reason={finish_reason}" if finish_reason != "stop" else None

    return res


# =========================================================
# 主流程
# =========================================================
def main() -> int:
    api_key = os.getenv("ZHIPU_API_KEY")
    if not api_key:
        print("[FATAL] 未找到 ZHIPU_API_KEY, 请在项目 .env 文件中填写:")
        print('        ZHIPU_API_KEY="你的智谱API Key"')
        return 2

    client = OpenAI(
        api_key=api_key,
        base_url="https://open.bigmodel.cn/api/paas/v4/",
        timeout=180.0,
    )

    results: List[RunResult] = []
    for i, cfg in enumerate(MODELS, 1):
        print(f"\n[{i}/{len(MODELS)}] 正在测速: {cfg['label']}  (model={cfg['model']}) ...", flush=True)
        r = run_one(client, cfg)
        results.append(r)

        status = "OK" if r.ok else f"ERR: {r.error}"
        print(
            f"    {'✅' if r.ok else '❌'} {cfg['label']:16s} | "
            f"TTFT={r.t_first_token*1000:7.0f}ms  "
            f"总耗时={r.t_total:6.2f}s  "
            f"生成={r.t_generation:6.2f}s  "
            f"字数={r.chars_no_space:5d}  "
            f"速度={r.chars_per_sec:6.1f}字/s  "
            f"状态={status}"
        )

    # ---- 保存 JSON ----
    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sys_prompt": SYS_PROMPT,
        "user_msg": USER_MSG,
        "temperature": TEMPERATURE,
        "results": [asdict(r) for r in results],
    }
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\n[DONE] 原始结果已保存到: {OUTPUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
