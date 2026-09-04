/* =========================================================
   塔罗 · 豆包风双页交互逻辑
   - state.phase: setup → (transition) → picking → reading
   - 保留原可用函数签名: teardownPreviousReading, setStatus,
     shuffle, renderWaitingBanner, transitionToStreaming
   - 后端接口: /api/config 和 POST /api/interpret (SSE) 不变
   ========================================================= */
(function () {
  "use strict";

  // ---- 全局状态 ----
  const state = {
    phase: "setup",            // setup | picking | reading
    cards: [],                 // 后端 78 张完整牌库 (含 arcana / suit / name / image)
    spreads: [],
    models: [],
    spreadId: "time3",
    modelId: "",               // 真实 glm-* 模型 id (传给后端用)
    question: "",
    picks: [],                 // {posIdx, card, upright, pickFrom}
    currPosIdx: 0,             // 当前待抽位置 (picking 阶段用)

    readingId: 0,              // 每次解读新建, 用来丢弃旧流
    readingState: "idle",      // idle | waiting | streaming | done
    abortCtrl: null,
    rotateTimer: null,
    sectionEls: new Map(),     // key: "pos-0" "overall" value: <div class="section body-text">
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // 5 段等待文案 (复用原版)
  const WAITING_STEPS = [
    { icon: "🔮", text: "正在感应你抽到的牌意能量……" },
    { icon: "📜", text: "正在翻阅古老的魔法典籍……" },
    { icon: "🪬", text: "正在构建牌阵之间的因果关联……" },
    { icon: "✨", text: "正在把牌意组织成你能理解的语言……" },
    { icon: "🌙", text: "正在融入你的问题背景做个性化拆解……" },
  ];

  // 牌库来源的显示名
  const SRC_LABEL = { Major: "大阿尔卡那 (22 张)", Minor: "小阿尔卡那 (56 张)", Full: "整副牌 (78 张)" };
  const MODEL_ICONS = {
    "glm-4-flash-250414": "⚡",
    "glm-4.6v-flash":       "🌙",
    "glm-4.7-flash":        "🐢",
    "glm-z1-flash":         "🧮",
  };
  const SPREAD_ICON = { yesno: "🎯", time3: "⏳", triangle: "🔺", cross5: "✚", celtic7: "⛩" };

  document.addEventListener("DOMContentLoaded", init);

  /* ------------------------- A. 初始化 ------------------------- */
  async function init() {
    try {
      const r = await fetch("/api/config");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const cfg = await r.json();
      state.cards   = cfg.cards;
      state.spreads = cfg.spreads;
      state.models  = cfg.models;

      // 默认模型: 4.6v-flash (综合首选), 向后兼容
      const def = state.models.find((m) => m.id === "glm-4.6v-flash") || state.models[0];
      state.modelId = def.id;
      if (!state.spreads.find((s) => s.id === state.spreadId)) state.spreadId = (state.spreads[0] || {}).id;

      renderSetupScreen();
      bindGlobal();
      setStatus("ok", `牌库就绪：${cfg.cards.length} 张，${cfg.spreads.length} 种牌阵 · 请先填写问题`);
      updateFocusBtn();
    } catch (e) {
      setStatus("err", "无法加载 /api/config: " + e.message);
    }
  }

  function bindGlobal() {
    $("#question").addEventListener("input", () => {
      state.question = $("#question").value;
      $("#q-count").textContent = state.question.length;
      updateFocusBtn();
    });
    $("#focus-btn").addEventListener("click", onStartFocus);
    // 抽牌 / 解读页的返回 / 撤销 / 开始 / 重试按钮
    $("#back-setup").addEventListener("click", () => switchPhase("setup"));
    $("#back-pick").addEventListener("click", () => { teardownPreviousReading({ silent: true }); switchPhase("setup"); });
    $("#btn-start-read").addEventListener("click", onStartRead);
    $("#read-retry-btn").addEventListener("click", onStartRead);
    // 模态关闭
    document.getElementById("card-modal").addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close === "1") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  /* ------------------------- B. Page1: Setup ------------------------- */
  function renderSetupScreen() {
    renderModels();
    renderSpreads();
  }

  function renderModels() {
    const host = $("#model-list");
    host.innerHTML = "";
    state.models.forEach((m) => {
      const el = document.createElement("div");
      el.className = "model-card" + (m.id === state.modelId ? " active" : "");
      el.dataset.modelId = m.id;
      el.innerHTML = `
        <div class="mc-ic">${MODEL_ICONS[m.id] || "✦"}</div>
        <div style="flex:1;min-width:0;">
          <div class="mc-name">${escapeHtml(m.alias || m.name)} <span class="mc-tag">${m.speed || ""}</span></div>
          <div class="mc-desc">${escapeHtml(m.personality || m.name)} · ${escapeHtml(m.pick || "")}${m.alias ? " · 模型: " + escapeHtml(m.name) : ""}</div>
        </div>`;
      el.addEventListener("click", () => {
        state.modelId = m.id;
        $$(".model-card").forEach((x) => x.classList.toggle("active", x.dataset.modelId === m.id));
      });
      host.appendChild(el);
    });
  }

  function renderSpreads() {
    const host = $("#spread-grid");
    host.innerHTML = "";
    state.spreads.forEach((s) => {
      const el = document.createElement("div");
      el.className = "spread-card" + (s.id === state.spreadId ? " active" : "");
      el.dataset.spreadId = s.id;
      el.innerHTML = `
        <div>
          <div class="sc-name">${SPREAD_ICON[s.id] || "🎴"} ${escapeHtml(s.name)}<span class="sc-count">${s.count}张</span></div>
          <div class="sc-desc">${escapeHtml(s.desc)}</div>
        </div>`;
      el.addEventListener("click", () => {
        state.spreadId = s.id;
        $$(".spread-card").forEach((x) => x.classList.toggle("active", x.dataset.spreadId === s.id));
      });
      host.appendChild(el);
    });
  }

  function updateFocusBtn() {
    const ok = state.question.trim().length >= 2 && !!state.modelId && !!state.spreadId;
    const btn = $("#focus-btn");
    if (!btn) return;
    btn.disabled = !ok;
    if (ok) btn.removeAttribute("disabled-state"); else btn.setAttribute("disabled-state", "");
  }

  /* ------------------------- C. 意念集中 → 过渡动画 → Page2 ------------------------- */
  function onStartFocus() {
    if (state.question.trim().length < 2) {
      setStatus("err", "请先输入你想问的问题（至少 2 个字）");
      $("#question").focus();
      return;
    }
    startTransition();
  }

  function startTransition() {
    const overlay = document.getElementById("transition-overlay");
    const canvas  = document.getElementById("fx-canvas");
    overlay.classList.add("show");
    // 适配高 DPI
    const dpr = window.devicePixelRatio || 1;
    const w = overlay.clientWidth, h = overlay.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    // 粒子 (从四方向内收敛)
    const N = Math.max(60, Math.min(140, Math.floor(w * h / 8500)));
    const cx = w / 2, cy = h / 2;
    const particles = new Array(N).fill(0).map(() => {
      const edge = Math.floor(Math.random() * 4);
      let x, y;
      if (edge === 0) { x = Math.random() * w; y = -10; }
      else if (edge === 1) { x = w + 10; y = Math.random() * h; }
      else if (edge === 2) { x = Math.random() * w; y = h + 10; }
      else                 { x = -10; y = Math.random() * h; }
      const dx = cx - x, dy = cy - y;
      const dist = Math.hypot(dx, dy) || 1;
      const speed = 2.4 + Math.random() * 3.4;
      const palette = ["#f5d58a", "#d6b06a", "#c49cff", "#9b69ff", "#ffffff"];
      return {
        x, y,
        vx: (dx / dist) * speed,
        vy: (dy / dist) * speed,
        r: 1 + Math.random() * 2.6,
        c: palette[Math.floor(Math.random() * palette.length)],
        a: 0.85,
      };
    });
    const t0 = performance.now();
    const DURATION = 2600;
    let rafId = 0;
    let finished = false;
    function finish() {
      if (finished) return; finished = true;
      try { cancelAnimationFrame(rafId); } catch (_) {}
      overlay.classList.remove("show");
      initPicking();
      switchPhase("picking");
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    function tick(now) {
      const t = Math.min(1, (now - t0) / DURATION);
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        const k = 1 + t * 2.4;
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vx *= 0.988; p.vy *= 0.988;
        p.a = Math.max(0, 0.85 - t * 0.95);
        ctx.beginPath();
        ctx.globalAlpha = p.a;
        ctx.fillStyle = p.c;
        ctx.shadowBlur = 10; ctx.shadowColor = p.c;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      if (t < 1) { rafId = requestAnimationFrame(tick); } else {
        setTimeout(finish, 120);
      }
    }
    rafId = requestAnimationFrame(tick);
    // 兜底 Watchdog: 3.2s 后不管动画是否到 1.0 都强制收束进入 picking 页面，避免 rAF 因后台/失焦停住
    setTimeout(finish, DURATION + 600);
  }

  /* ------------------------- D. Page2: 扇面抽牌 ------------------------- */
  function initPicking() {
    const sp = spread();
    state.picks = new Array(sp.count).fill(null);
    state.currPosIdx = 0;
    renderSlots();
    renderPickHeader();
    renderFanForCurrent();
    renderCTA();
  }

  function spread() { return state.spreads.find((s) => s.id === state.spreadId); }
  function model()  { return state.models.find((m) => m.id === state.modelId); }

  function cardsForSrc(src) {
    const usedNames = new Set(state.picks.filter(Boolean).map((p) => p.card.name));
    return state.cards.filter((c) => {
      if (usedNames.has(c.name)) return false;
      if (src === "Major") return c.arcana === "Major";
      if (src === "Minor") return c.arcana !== "Major";
      return true;
    });
  }

  function renderPickHeader() {
    const sp = spread();
    $("#pick-spread-name").textContent = `${SPREAD_ICON[sp.id] || "🎴"} ${sp.name} · 共 ${sp.count} 张`;
    const picked = state.picks.filter(Boolean).length;
    $("#pick-progress").innerHTML = `已抽 <b>${picked}</b> / ${sp.count} 张`;
    const cur = sp.positions[state.currPosIdx];
    const chip = $("#pick-source-chip");
    chip.dataset.src = cur ? cur.pickFrom : "Full";
    chip.textContent = `牌库：${SRC_LABEL[cur ? cur.pickFrom : "Full"] || cur.pickFrom}`;
  }

  function renderSlots() {
    const sp = spread();
    const host = document.getElementById("pick-slots");
    host.innerHTML = "";
    sp.positions.forEach((pos, i) => {
      const pick = state.picks[i];
      const slot = document.createElement("div");
      slot.className = "pick-slot" + (i === state.currPosIdx && !pick ? " active" : "") + (pick ? " filled" : "");
      slot.dataset.posIdx = i;
      const thumbCls = pick && !pick.upright ? " reversed" : "";
      const thumbInner = pick
        ? `<img src="/static/card/${encodeURI(pick.card.image)}" alt="${pick.card.name}" loading="lazy"/>`
        : `<span>空</span>`;
      slot.innerHTML = `
        <div style="position:relative;">
          <div class="slot-idx">${i + 1}</div>
          <div class="slot-thumb${thumbCls}">${thumbInner}</div>
        </div>
        <div class="slot-meta">
          <div class="slot-label">${escapeHtml(pos.label)}</div>
          <div class="slot-hint">${escapeHtml(pos.hint || "")}</div>
          ${pick ? `
            <div class="slot-card">
              ${escapeHtml(pick.card.name)}
              <span class="pos-tag ${pick.upright ? "upright" : "reversed"}">${pick.upright ? "正位" : "逆位"}</span>
            </div>` : ""}
        </div>
        <div class="slot-actions">
          <div class="slot-src" data-src="${pos.pickFrom}">${srcChipLabel(pos.pickFrom)}</div>
        </div>`;
      if (pick) {
        slot.querySelector(".slot-thumb").addEventListener("click", () => openModal(i));
      } else {
        slot.addEventListener("click", () => {
          if (state.currPosIdx !== i) { state.currPosIdx = i; renderSlots(); renderPickHeader(); renderFanForCurrent(); renderCTA(); }
        });
      }
      host.appendChild(slot);
    });
  }

  function srcChipLabel(src) {
    return src === "Major" ? "大阿尔卡那" : src === "Minor" ? "小阿尔卡那" : "整副";
  }

  function renderFanForCurrent() {
    const sp = spread();
    const pos = sp.positions[state.currPosIdx];
    if (!pos) return;
    // 顶部提示
    $("#pick-cur-position").textContent = `第 ${state.currPosIdx + 1} / ${sp.count} 张 · ${pos.label}`;
    $("#pick-cur-hint").textContent = pos.hint || "";

    const host = document.getElementById("fan-container");
    host.innerHTML = "";
    const pool = cardsForSrc(pos.pickFrom);
    const n = pool.length;
    if (n === 0) {
      host.innerHTML = `<div style="color:var(--fg-2);padding:20px;text-align:center;">该牌库已无可用卡片，请先撤回已选牌或换一个牌阵。</div>`;
      return;
    }
    // 扇形角度: 对于 N<25 不用太开，最多用 ±65°
    const totalDeg = Math.min(130, 22 + n * 1.6); // -65 ~ +65: 130 deg
    const step = n > 1 ? totalDeg / (n - 1) : 0;
    const start = -totalDeg / 2;
    const radius = 780; // 与 CSS transform-origin 匹配
    const isCompact = window.matchMedia("(max-width: 560px)").matches;
    if (isCompact || n > 48) {
      // 网格 fallback: 避免 56/78 张扇面太挤 看不清
      host.style.display = "grid";
      host.style.gridTemplateColumns = "repeat(auto-fit, minmax(92px, 1fr))";
      host.style.alignItems = "stretch";
      host.style.gap = "10px";
    } else {
      host.style.display = "flex"; host.style.gap = "";
      host.style.alignItems = "flex-end";
    }
    pool.forEach((card, i) => {
      const el = document.createElement("div");
      el.className = "fan-card";
      el.dataset.name = card.name;
      if (window.matchMedia("(max-width: 560px)").matches || n > 48) {
        // 网格卡片：带微小 3D 感, 尺寸固定
        el.style.position = "relative";
        el.style.bottom = "auto";
        el.style.left = "auto";
        el.style.transform = "none";
        el.style.transformOrigin = "center center";
        el.style.width = "92px";
        el.style.height = "148px";
      } else {
        const deg = start + i * step;
        const angle = deg + "deg";
        const r = radius + "px";
        el.style.setProperty("--angle", angle);
        el.style.setProperty("--r", r);
        el.style.transform = `rotate(${angle}) translateY(-${r})`;
      }
      el.title = card.name;
      el.addEventListener("click", () => pickCard(card, el));
      host.appendChild(el);
    });
  }

  function pickCard(card, fanEl) {
    if (state.phase !== "picking") return;
    const sp = spread();
    const posIdx = state.currPosIdx;
    const pos = sp.positions[posIdx];
    if (!pos || state.picks[posIdx]) return;
    const upright = Math.random() < 0.5;
    const pick = { posIdx, card, upright, pickFrom: pos.pickFrom };
    // 飞入动画 (使用 fan 屏幕坐标 → slot 坐标)
    const a = fanEl.getBoundingClientRect();
    animateFlyCard(card, upright, a, posIdx, () => {
      state.picks[posIdx] = pick;
      const next = state.picks.findIndex((x) => x === null);
      state.currPosIdx = next >= 0 ? next : Math.min(sp.count - 1, state.picks.length - 1);
      renderSlots();
      renderPickHeader();
      if (next >= 0) {
        renderFanForCurrent();
        renderCTA();
      } else {
        document.getElementById("fan-container").innerHTML = `<div style="padding:30px;text-align:center;color:var(--fg-2);">✨ 已抽齐 ${sp.count} 张 · 正在进入感应解读…</div>`;
        renderCTA();
        // 抽完自动进入解读，不再允许换牌
        setTimeout(() => onStartRead(), 650);
      }
    });
  }

  function animateFlyCard(card, upright, fromRect, posIdx, done) {
    const sp = spread();
    const slots = Array.from(document.querySelectorAll(".pick-slot"));
    const slotEl = slots.find((el) => String(el.dataset.posIdx) === String(posIdx));
    const fly = document.createElement("div");
    fly.className = "fly-card" + (upright ? "" : " reversed");
    fly.innerHTML = `<img src="/static/card/${encodeURI(card.image)}" alt="${card.name}"/>`;
    Object.assign(fly.style, {
      left: fromRect.left + "px",
      top:  fromRect.top + "px",
      width: fromRect.width + "px",
      height: fromRect.height + "px",
    });
    document.body.appendChild(fly);
    let slotRect = null;
    if (slotEl) {
      const t = slotEl.querySelector(".slot-thumb") || slotEl;
      slotRect = t.getBoundingClientRect();
    } else {
      slotRect = fromRect;
    }
    const dx = slotRect.left - fromRect.left;
    const dy = slotRect.top  - fromRect.top;
    const sx = slotRect.width  / Math.max(1, fromRect.width);
    const sy = slotRect.height / Math.max(1, fromRect.height);
    const D  = 760; // 动画总时长 (flip 240 + fly 520)
    let doneCalled = false;
    function finalize() {
      if (doneCalled) return;
      doneCalled = true;
      try { fly.remove(); } catch (_) {}
      done && done();
    }
    try {
      // 把翻牌 + 位移合成到一条 WAAPI，避免两条 fill:"forwards" 互相覆盖
      const anim = fly.animate(
        [
          { transform: "rotateY(180deg) translate(0px,0px) scale(1)",   opacity: 1, offset: 0 },
          { transform: "rotateY(0deg)   translate(0px,0px) scale(1)",   opacity: 1, offset: 0.32 },
          { transform: `rotateY(0deg)   translate(${dx}px,${dy}px) scale(${Math.min(sx, sy)})`, opacity: 1, offset: 1 },
        ],
        { duration: D, easing: "cubic-bezier(.22,.8,.2,1)", fill: "forwards" }
      );
      try {
        anim.onfinish = () => setTimeout(finalize, 60);
      } catch (_) {
        // 旧浏览器不支持 onfinish，下面 watchdog 兜底
      }
    } catch (_e) {
      // WAAPI 不可用时 fallback 纯 CSS 过渡最终样式 + 立即 finalize
      fly.style.transition = "transform 760ms cubic-bezier(.22,.8,.2,1), opacity 420ms";
      fly.style.transform = `translate(${dx}px,${dy}px) scale(${Math.min(sx, sy)})`;
      fly.style.transformOrigin = "center";
    }
    // 兜底：1.15s 后不管动画是否结束，都 finalize（保证 pick 被持久化，解读能自动触发）
    setTimeout(finalize, Math.max(900, D + 260));
  }

  function renderCTA() {
    const picked = state.picks.filter(Boolean).length;
    const total = state.picks.length;
    const full = picked === total;
    const btn = document.getElementById("btn-start-read");
    if (btn) {
      btn.disabled = !full;
      if (full) btn.removeAttribute("disabled-state");
      else btn.setAttribute("disabled-state", "");
    }
  }

  /* ------------------------- E. Page3: 左缩略 + 右分卡解读 (SSE) ------------------------- */
  function onStartRead() {
    const sp = spread();
    if (state.picks.filter(Boolean).length !== sp.count) {
      setStatus("err", `还需抽 ${sp.count - state.picks.filter(Boolean).length} 张牌`);
      return;
    }
    switchPhase("reading");
    teardownPreviousReading({ silent: true });
    state.readingId++;
    const myReadId = state.readingId;
    const ctrl = new AbortController();
    state.abortCtrl = ctrl;

    renderThumbs();
    renderReadingHeader();
    renderReadingPlaceholder();
    renderSectionBuckets(true /*new*/);
    renderWaitingBanner($("#reading"), sp.name, (model().alias || model().name));
    // 顶栏 计时器
    document.getElementById("read-chip-elapsed").textContent = "用时：0s";
    const t0 = Date.now();
    const tickTimer = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      const el = document.getElementById("read-chip-elapsed");
      if (el) el.textContent = `用时：${sec}s`;
    }, 500);

    state.readingState = "waiting";
    setStatus("", "正在向解读师发送牌阵，请稍候…");

    let gotFirstText = false;
    let gotText = false;
    let done = false;
    let buf = "";
    // 用来切换当前段落 bucket 的游标: "overall" 或 posIdx 数字 (1..N)
    // 初始 = overall, 遇到 ## N. 位置名 → bucket = `pos-${N-1}`
    // 之后再匹配 "总体结论" → bucket = "overall" (写总结段)
    let currentBucketKey = "overall";

    // sectionEls: 每个 bucket 的 <p> 容器 (写入文本)
    // 还需要为总体 disclaimer 写第一行
    const disclaimerLine = document.createElement("div");
    disclaimerLine.className = "disclaimer-line";
    disclaimerLine.textContent = "【塔罗仅为心理隐喻娱乐，不可作为重大决策依据】";
    $("#reading").appendChild(disclaimerLine);
    renderSectionBuckets(false /*after banner*/);

    try {
      doFetch();
    } catch (eSync) { handleReadError(eSync); }

    // ----- helpers inside onStartRead -----
    function doFetch() {
      const positions = sp.positions;
      const cardsPayload = state.picks.map((p, i) => ({
        name: p.card.name,
        image: p.card.image,
        upright: p.upright,
        position: positions[i] ? positions[i].label : "",
      }));
      fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          question: state.question.trim(),
          spread_id: sp.id,
          model_id: state.modelId,
          positions: positions,
          cards: cardsPayload,
        }),
      }).then(async (resp) => {
        if (state.readingId !== myReadId) return; // 被废弃的老请求
        if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText);
        if (!resp.body) throw new Error("浏览器不支持 stream body");
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        while (!done) {
          const { value, done: d } = await reader.read();
          if (state.readingId !== myReadId || ctrl.signal.aborted) break;
          if (d) done = true;
          if (value) buf += decoder.decode(value, { stream: !done });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || "";
          for (const line of lines) {
            const ln = line.replace(/^data:\s*/, "").trim();
            if (!ln) continue;
            try {
              const j = JSON.parse(ln);
              if (!j.ok) throw new Error(j.error || "解读失败");
              if (typeof j.text === "string" && j.text) {
                if (!gotFirstText) { gotFirstText = true; transitionToStreaming(); }
                appendTextChunk(j.text);
                gotText = true;
              }
              if (j.done) done = true;
            } catch (e2) {
              // 非 JSON 的 data 行跳过; 如果是明确的服务端错误就抛出
              if (e2 && e2.message && /牌库中找不到|未知牌阵|未知模型|请输入|牌阵需要/.test(e2.message)) throw e2;
            }
          }
        }
        if (state.readingId !== myReadId) return cleanupSilent();
        afterAllDone(gotText, Math.round((Date.now() - t0) / 1000));
      }).catch((e) => handleReadError(e));
    }

    function appendTextChunk(rawText) {
      if (state.readingId !== myReadId) return;
      // 前端兜底: 彻底剥除 <think>…</think>（按块级索引扫，支持跨 chunk 开头闭合的完整 think 段，也支持未闭合开标签攒到下次）
      thinkBuf += rawText;
      const OPEN = "<think";
      const CLOSE = "</think>";
      while (true) {
        const o = thinkBuf.indexOf(OPEN);
        if (o < 0) break;
        const gt = thinkBuf.indexOf(">", o + OPEN.length);
        if (gt < 0) {
          // <think 本身没写完: 全部攒着
          pieceTmp = "";
          thinkBuf = thinkBuf.slice(0); // 原样保留
          thinkBuf_left = "";
          break;
        }
        const c = thinkBuf.indexOf(CLOSE, gt + 1);
        if (c < 0) {
          // <thinkX> 已完整但还没 </think>: 前面的部分吐出, 后面的保留
          thinkBuf_left = thinkBuf.slice(0, o);
          thinkBuf = thinkBuf.slice(o);
          pieceTmp = "";
          break;
        }
        // 完整段: 删除整段再循环
        thinkBuf = thinkBuf.slice(0, o) + thinkBuf.slice(c + CLOSE.length);
        pieceTmp = "";
        thinkBuf_left = "";
      }
      let piece = thinkBuf_left ? thinkBuf_left : (thinkBuf.indexOf(OPEN) >= 0 ? "" : thinkBuf);
      if (thinkBuf.indexOf(OPEN) < 0) thinkBuf = "";
      if (!piece) return;

      // ---- 逐行扫描（最严格的不重复方案） ----
      // 规则: 我们只把 "完整行" 立即写为永久节点; 对于 "未换行行尾的半行", 只记录到当前 bucket 的 pendingLine，
      //       不碰 DOM。每次 appendTextChunk 末尾: 把 DOM 里上次挂的临时 pending 节点删掉, 再用当前 bucket 的 pendingLine 新建一个临时节点.
      //       -> 这样无论 chunk 怎么切、怎么在同一行、bucket 切换时把半行"迁移"到新 bucket，都永远不会出现同一字符被写两遍的重复。
      lineBuf += piece;
      const rawLines = lineBuf.split("\n");
      if (rawLines.length >= 2) {
        // 第一条完整行 = 上一轮半行 pending (如果属于当前 bucket) + 本 chunk 首段 rawLines[0]
        const firstFull = (state._pendingLine || "") + rawLines[0];
        // N-1 条完整行 (firstFull + 中间段 rawLines[1]..rawLines[N-2]) 分别 flush
        const fulls = [firstFull].concat(rawLines.slice(1, rawLines.length - 1));
        state._pendingLine = "";
        for (let i = 0; i < fulls.length; i++) {
          currentLine = fulls[i];
          flushLine();
        }
        // 新的半行 = rawLines[last]
        state._pendingLine = rawLines[rawLines.length - 1];
        state._pendingBucket = currentBucketKey;
        lineBuf = "";
      } else {
        // 没有换行, 仅累积 pendingLine
        state._pendingLine = (state._pendingLine || "") + rawLines[0];
        state._pendingBucket = currentBucketKey;
        lineBuf = "";
      }
      refreshPendingTempNode();
    }

    let currentLine = "";
    let lineBuf = "";
    let thinkBuf = "";
    var pieceTmp = "";
    var thinkBuf_left = "";

    function refreshPendingTempNode() {
      // 清除所有 bucket 里存在的 _tempNode（pending 行尾显示），再只给当前 pendingBucket 写最新的 pendingLine
      if (!state.sectionEls) return;
      for (const [key, body] of state.sectionEls.entries()) {
        if (!body) continue;
        if (key.endsWith("-wrap")) continue; // 只对 sec-body
        if (body._tempNode) {
          try { body.removeChild(body._tempNode); } catch (_) {}
          body._tempNode = null;
        }
      }
      const line = state._pendingLine || "";
      if (!line) return;
      const key = state._pendingBucket || currentBucketKey || "overall";
      const body = state.sectionEls.get(key);
      if (!body) return;
      // 如果 pendingLine 本身是一个 ## 标题: 不要当正文写 (会在下一次 flushLine 时处理迁移)
      if (/^##\s+/.test(line)) return;
      const tn = document.createTextNode(line);
      body.appendChild(tn);
      body._tempNode = tn;
    }

    function flushLine() {
      const line = currentLine;
      currentLine = "";
      // 结束当前 pendingLine: 新的一轮是 clean state
      state._pendingLine = "";
      state._pendingBucket = currentBucketKey;
      if (!line) {
        writeToBucket(currentBucketKey, "\n", false);
        return;
      }
      // 1. Markdown 二级标题 → 切换 bucket / 更新 section h3, 不写正文
      const h = line.match(/^##\s+(.+?)\s*$/);
      if (h) {
        const title = h[1].trim();
        const m = title.match(/^(\d+)[\.、]\s*(.+)$/);
        let key = currentBucketKey;
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= sp.count) key = "pos-" + (n - 1);
        } else if (/总体结论|关系呼应|行动建议|温暖鼓励/.test(title)) {
          key = "overall";
        }
        currentBucketKey = key;
        state._pendingBucket = key; // 切换 bucket 时，立即同步 pending 归属，避免 tempNode 写错容器
        setSectionHeader(key, title);
        return;
      }
      // 2. 跳过免责声明重复
      if (/塔罗仅为心理隐喻娱乐|不可作为重大决策依据/.test(line)) return;
      writeToBucket(currentBucketKey, line + "\n", false);
    }

    function setSectionHeader(key, title) {
      const wrap = state.sectionEls.get(key + "-wrap");
      if (!wrap) return;
      const h = wrap.querySelector(":scope > h3");
      if (h) {
        h.textContent = "";
        if (/^pos-\d+$/.test(key)) {
          const mm = title.match(/^(\d+)/);
          const idxNum = mm ? mm[1] : (parseInt(key.slice(4), 10) | 0) + 1;
          const sidx = document.createElement("span"); sidx.className = "sec-idx"; sidx.textContent = String(idxNum);
          const rest = mm ? title.replace(/^\d+[\.、]\s*/, "") : title;
          const span = document.createElement("span"); span.textContent = rest;
          h.appendChild(sidx); h.appendChild(span);
        } else {
          h.textContent = title;
        }
      }
      const posMatch = /^pos-(\d+)$/.exec(key);
      if (posMatch) highlightThumb(parseInt(posMatch[1], 10));
    }

    function writeToBucket(key, text, mode) {
      // mode: false              → 永久追加文本节点 (整行一次性写完)
      //       "TEMP_APPEND_OR_RESET" → 末尾半句: 存在 tempNode 就拼到其后, 否则新建 tempNode
      //       "CLEAR_TEMP"       → 只清空 tempNode.nodeValue (不移除节点, 保持占位), 用来清半标题
      const body = state.sectionEls.get(key);
      if (!body) return;
      if (mode === "CLEAR_TEMP") {
        if (body._tempNode) body._tempNode.nodeValue = "";
        return;
      }
      if (mode === "TEMP_APPEND_OR_RESET") {
        if (body._tempNode) body._tempNode.nodeValue += text;
        else {
          const tn = document.createTextNode(text);
          body.appendChild(tn); body._tempNode = tn;
        }
        return;
      }
      // 永久写: **先从 DOM 中移除旧的 tempNode（它包含的半行 pending 已被拼到新行里，不然正文会出现双倍段）**
      if (body._tempNode) {
        try { body.removeChild(body._tempNode); } catch (_) {}
        body._tempNode = null;
      }
      const tn = document.createTextNode(text);
      body.appendChild(tn);

      // 同步缩略预览 / modal-read 当前内容
      const posMatch = /^pos-(\d+)$/.exec(key);
      if (posMatch) {
        const i = parseInt(posMatch[1], 10);
        const preview = document.querySelector(`.thumb-card[data-pos-idx="${i}"] .thumb-preview`);
        if (preview) preview.textContent = stripForPreview(
          (state.sectionEls.get("pos-" + i) || {}).textContent || ""
        );
        const modalRead = document.getElementById("modal-read");
        if (modalRead && lastModalPosIdx === i) modalRead.textContent = stripForPreview(
          (state.sectionEls.get("pos-" + i) || {}).textContent || ""
        );
      }
      const caret = document.querySelector("#reading .caret");
      if (caret) caret.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    function afterAllDone(gotTextFlag, sec) {
      cleanupAfterRead();
      clearInterval(tickTimer);
      const el = document.getElementById("read-chip-elapsed");
      if (el) el.textContent = `用时：${sec}s`;
      if (gotTextFlag) setStatus("ok", `解读完成（${sec}s）。可以点「🔁 再解读一次」，或回到第一步换别的问题 / 牌阵。`);
      else if (!ctrl.signal.aborted) setStatus("err", "模型未返回任何文本，请重试或更换模型。");
      // 按钮可用
      const btn = document.getElementById("read-retry-btn");
      btn.disabled = false; btn.removeAttribute("disabled-state");
      setMiniBadgeHidden();
      // 最后写入的临时行, 如果没有换行, 可能仍在 currentLine 里: 执行一次 flushLine 结束
      if (currentLine) { flushLine(); writeToBucket(currentBucketKey, "", true); }
    }

    function cleanupSilent() { clearInterval(tickTimer); try { ctrl && ctrl.abort && ctrl.abort(); } catch (_) {} }

    function handleReadError(e) {
      if (state.readingId !== myReadId) { return cleanupSilent(); }
      cleanupAfterRead();
      clearInterval(tickTimer);
      const aborted = e && (e.name === "AbortError" || ctrl.signal.aborted);
      if (aborted) {
        setStatus("", "已取消上一次解读。");
        return;
      }
      // 把错误写入 overall 段, 并确保文本框可见
      transitionToStreaming();
      writeToBucket("overall", "\n\n[出错] " + (e && e.message ? e.message : String(e)), false);
      setStatus("err", "解读失败：" + (e && e.message ? e.message : e));
    }
  } // end onStartRead

  let lastModalPosIdx = -1;

  function renderReadingHeader() {
    const sp = spread();
    const mo = model();
    document.getElementById("read-chip-spread").textContent = `牌阵：${sp.name}（${sp.count} 张）`;
    document.getElementById("read-chip-model").textContent  = `解读师：${mo.alias || mo.name}`;
    const retryBtn = document.getElementById("read-retry-btn");
    retryBtn.disabled = true; retryBtn.setAttribute("disabled-state", "");
  }

  function renderReadingPlaceholder() {
    const host = $("#reading");
    host.innerHTML = ""; // 清空, waiting-banner 会在随后附加
  }

  function renderThumbs() {
    const sp = spread();
    const host = document.getElementById("thumbs");
    host.innerHTML = "";
    state.picks.forEach((p, i) => {
      if (!p) return;
      const pos = sp.positions[i];
      const t = document.createElement("div");
      t.className = "thumb-card";
      t.dataset.posIdx = i;
      t.innerHTML = `
        <div class="thumb-img${p.upright ? "" : " reversed"}"><img src="/static/card/${encodeURI(p.card.image)}" alt="${p.card.name}" loading="lazy"/></div>
        <div class="thumb-body">
          <div class="thumb-label">${escapeHtml(pos.label)}</div>
          <div class="thumb-cardname">
            ${escapeHtml(p.card.name)}
            <span class="pos-tag ${p.upright ? "upright" : "reversed"}">${p.upright ? "正位" : "逆位"}</span>
          </div>
          <div class="thumb-preview"></div>
        </div>`;
      t.addEventListener("click", () => openModal(i));
      host.appendChild(t);
    });
  }

  function highlightThumb(posIdx) {
    document.querySelectorAll(".thumb-card").forEach((el) => {
      el.classList.toggle("active", String(el.dataset.posIdx) === String(posIdx));
    });
  }

  function stripForPreview(s) {
    return (s || "").replace(/\s+/g, " ").slice(0, 260);
  }

  // 为每个 bucket (pos-0..N-1 / overall) 创建 section DOM, 并把 section 容器 / 文本 body 存入 state.sectionEls
  function renderSectionBuckets(rebuild) {
    const host = $("#reading");
    if (rebuild) {
      state.sectionEls = new Map();
      // 这里不清空 disclaimer / waiting banner, 让他们由外层顺序控制.
      // 由于本函数被调用两次(第一次是 placeholder 之后, 第二次是 appendChild(disclaimerLine) 之前), 我们只在第二次时创建 bucket.
      return;
    }
    // 先 overall, 再按 pos 顺序
    createSection(host, "overall", "🫧 总体解读（等待中）", true);
    const sp = spread();
    for (let i = 0; i < sp.count; i++) {
      const p = state.picks[i];
      const pos = sp.positions[i];
      const cardLabel = p ? `（${p.card.name}·${p.upright ? "正位" : "逆位"}）` : "";
      createSection(host, "pos-" + i, `${i + 1}. ${pos.label} ${cardLabel}`, false, i + 1);
    }
    // 末尾加 caret 供滚动对齐
    const caret = document.createElement("span");
    caret.className = "caret";
    host.appendChild(caret);
    // footer meta
    const meta = document.createElement("div");
    meta.className = "read-footer-meta";
    meta.id = "read-meta";
    host.appendChild(meta);
  }

  function createSection(host, key, defaultTitle, isOverall, idxNum) {
    const wrap = document.createElement("div");
    wrap.className = "section" + (isOverall ? " overall" : "");
    wrap.dataset.sectionKey = key;
    const h3 = document.createElement("h3");
    if (idxNum != null) {
      const sidx = document.createElement("span"); sidx.className = "sec-idx"; sidx.textContent = String(idxNum);
      h3.appendChild(sidx);
      const sp = document.createElement("span"); sp.textContent = defaultTitle.replace(/^\d+\.\s*/, "");
      h3.appendChild(sp);
    } else {
      h3.textContent = defaultTitle;
    }
    const body = document.createElement("p");
    body.className = "sec-body";
    wrap.appendChild(h3); wrap.appendChild(body);
    host.appendChild(wrap);
    state.sectionEls.set(key + "-wrap", wrap);
    state.sectionEls.set(key, body);
  }

  /* ------------------------- F. 阶段切换 ------------------------- */
  function switchPhase(next) {
    state.phase = next;
    const setup = document.getElementById("page-setup");
    const pick  = document.getElementById("page-pick");
    const read  = document.getElementById("page-read");
    const show = (el, on) => { if (!el) return; if (on) el.classList.remove("hidden"); else el.classList.add("hidden"); };
    show(setup, next === "setup");
    show(pick,  next === "picking");
    show(read,  next === "reading");
    if (next === "picking") {
      // 如果 slots 还没渲染 (例如直接点后退没 initPicking) 就渲染
      if (state.picks.length !== spread().count) initPicking();
    }
    if (next === "setup") {
      teardownPreviousReading({ silent: true });
      $("#question").focus();
      updateFocusBtn();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ------------------------- G. 模态 (大图 + 该位置解读片段) ------------------------- */
  function openModal(posIdx) {
    const p = state.picks[posIdx];
    if (!p) return;
    const sp = spread();
    const pos = sp.positions[posIdx];
    lastModalPosIdx = posIdx;
    const wrap = document.getElementById("modal-img-wrap");
    wrap.classList.toggle("reversed", !p.upright);
    const img = document.getElementById("modal-img");
    img.src = "/static/card/" + encodeURI(p.card.image);
    img.alt = p.card.name;
    const title = document.getElementById("modal-title");
    title.textContent = "";
    const t1 = document.createElement("span"); t1.textContent = p.card.name;
    const t2 = document.createElement("span"); t2.className = "pos-tag " + (p.upright ? "upright" : "reversed");
    t2.textContent = p.upright ? "正位" : "逆位";
    title.appendChild(t1); title.appendChild(t2);
    document.getElementById("modal-pos").textContent = `位置：${pos.label} — ${pos.hint || ""}`;
    const mr = document.getElementById("modal-read");
    const body = state.sectionEls.get("pos-" + posIdx);
    const preview = document.querySelector(`.thumb-card[data-pos-idx="${posIdx}"] .thumb-preview`);
    mr.textContent = (body ? (body.textContent || "") : "") || (preview ? preview.textContent || "" : "") ||
      "该位置的解读还在接收中，等解读完成再打开可以看到完整的段落。";
    document.getElementById("card-modal").classList.remove("hidden");
  }
  function closeModal() {
    document.getElementById("card-modal").classList.add("hidden");
    lastModalPosIdx = -1;
  }

  /* ------------------------- H. 复用原版函数 (保留签名/语义) ------------------------- */
  function teardownPreviousReading({ silent }) {
    if (state.abortCtrl && typeof state.abortCtrl.abort === "function") {
      try { state.abortCtrl.abort(); } catch (_) {}
    }
    state.abortCtrl = null;
    if (state.rotateTimer) { clearInterval(state.rotateTimer); state.rotateTimer = null; }
    state.readingId++;
    state.readingState = "idle";
    if (!silent) { /* 占位 */ }
  }
  function setStatus(kind, text) {
    const s = $("#status");
    s.className = "status" + (kind ? " " + kind : "");
    s.textContent = text || "";
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 保留: waiting banner 5 步 + 流式 badge
  function renderWaitingBanner(host, spName, modelName) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="waiting-banner" id="wait-box">
        <div class="waiting-visuals">
          <div class="w-crystal"><span>🔮</span></div>
          <div class="w-book"><span>📖</span></div>
          <div class="w-sparkle s1">✦</div>
          <div class="w-sparkle s2">✧</div>
          <div class="w-sparkle s3">✦</div>
        </div>
        <div class="waiting-meta">
          <div class="waiting-title">塔罗灵视正在开启…</div>
          <div class="waiting-sub">牌阵：${escapeHtml(spName)} · 解读师：${escapeHtml(modelName)}</div>
          <ul class="waiting-steps" id="wait-steps"></ul>
          <div class="waiting-tip">如果长时间无响应，请检查网络或更换模型重试</div>
        </div>
      </div>
      <div class="reading-content" id="read-box" style="display:none;">
        <div id="rb-inner"></div><span class="caret"></span>
      </div>
      <div class="streaming-mini" id="stream-mini" style="display:none;">
        <span class="mini-dot"></span><span id="mini-text">解读仍在继续…</span>
      </div>
      <div class="read-footer-meta" id="read-meta"></div>`;
    // 把 waiting-banner 放到 host 开头 (整体 section bucket 放在后面)
    host.insertBefore(wrap.querySelector("#wait-box"), host.firstChild);
    const mini = wrap.querySelector("#stream-mini");
    host.appendChild(mini);
    const ul = host.querySelector("#wait-steps") || document.getElementById("wait-steps") || host.querySelector(".waiting-steps");
    if (ul) {
      ul.innerHTML = "";
      WAITING_STEPS.forEach((s, i) => {
        const li = document.createElement("li");
        li.className = "step" + (i === 0 ? " active" : "");
        li.innerHTML = `<span class="step-ic">${s.icon}</span><span class="step-tx">${s.text}</span><span class="step-dot"></span>`;
        ul.appendChild(li);
      });
      let cur = 0;
      const allLi = ul.querySelectorAll(".step");
      state.rotateTimer = setInterval(() => {
        if (state.readingState === "idle" || state.readingState === "done") return;
        allLi[cur].classList.remove("active");
        allLi[cur].classList.add("done");
        cur = (cur + 1) % WAITING_STEPS.length;
        allLi.forEach((x, i) => {
          if (i === cur) { x.classList.add("active"); x.classList.remove("done"); }
        });
      }, 2600);
    }
  }

  function transitionToStreaming() {
    const waitBox = document.getElementById("wait-box") || document.querySelector(".waiting-banner");
    const mini   = document.getElementById("stream-mini") || document.querySelector(".streaming-mini");
    const box    = document.getElementById("read-box");
    if (waitBox) {
      waitBox.classList.add("shrink");
      setTimeout(() => { if (waitBox) waitBox.style.display = "none"; }, 420);
    }
    if (box) box.style.display = "";
    if (mini) mini.style.display = "";
    state.readingState = "streaming";
  }

  function setMiniBadgeHidden() {
    const mini = document.querySelector(".streaming-mini");
    if (!mini) return;
    mini.classList.add("fade-out");
    setTimeout(() => { mini && (mini.style.display = "none"); }, 420);
  }

  function cleanupAfterRead() {
    state.readingState = "done";
    if (state.rotateTimer) { clearInterval(state.rotateTimer); state.rotateTimer = null; }
    const caret = document.querySelector("#reading .caret");
    if (caret) caret.remove();
    setMiniBadgeHidden();
    try { state.abortCtrl && state.abortCtrl.abort && state.abortCtrl.abort(); } catch (_) {}
    state.abortCtrl = null;
    // 同步 thumb-preview 的最终态 (把 body 里完整内容写进去)
    const sp = spread();
    for (let i = 0; i < sp.count; i++) {
      const body = state.sectionEls.get("pos-" + i);
      const prev = document.querySelector(`.thumb-card[data-pos-idx="${i}"] .thumb-preview`);
      if (body && prev) prev.textContent = stripForPreview(body.textContent || "");
    }
  }

  /* ------------------------- I. 工具 ------------------------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

})();
