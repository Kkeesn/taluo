/* =====================================================
   塔罗解读前端: 抽牌 + SSE 流式渲染 + 动效 + 牌阵布局
   ===================================================== */
(function () {
  "use strict";

  // ---- 全局状态 ----
  const state = {
    cards: [],
    spreads: [],
    models: [],
    deck: [],
    drawn: [],
    spreadId: "time3",
    modelId: "",
    readingId: 0,
    /** idle | waiting(首字节前) | streaming(有文本) | done */
    readingState: "idle",
    abortCtrl: null,       // 每次解读新建, 下一次/重置时 abort()
    rotateTimer: null,     // 等待文案轮播定时器
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // 等待轮播文案 (按顺序, 每 2.6s 切一句)
  const WAITING_STEPS = [
    { icon: "🔮", text: "正在感应你抽到的牌意能量……" },
    { icon: "📜", text: "正在翻阅古老的魔法典籍……" },
    { icon: "🪬", text: "正在构建牌阵之间的因果关联……" },
    { icon: "✨", text: "正在把牌意组织成你能理解的语言……" },
    { icon: "🌙", text: "正在融入你的问题背景做个性化拆解……" },
  ];

  // =========================================================
  //  A. 初始化 / 事件绑定
  // =========================================================
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      const r = await fetch("/api/config");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const cfg = await r.json();
      state.cards = cfg.cards;
      state.spreads = cfg.spreads;
      state.models = cfg.models;

      renderSpreads();
      renderModels();
      applySpread(state.spreadId);
      setStatus("ok", `牌库就绪：${cfg.cards.length} 张，${cfg.spreads.length} 种牌阵`);
      bind();
    } catch (e) {
      setStatus("err", "无法加载 /api/config: " + e.message);
    }
  }

  function bind() {
    $("#draw-btn").addEventListener("click", onDraw);
    $("#reset-btn").addEventListener("click", onReset);
    // #read-btn 是在 applySpread / onReset 中重新创建 DOM 的，用事件委托更稳
    $("#reading").addEventListener("click", (e) => {
      if (e.target && e.target.id === "read-btn") onRead();
    });
    $("#question").addEventListener("input", () => {
      $("#q-count").textContent = $("#question").value.length;
    });
  }

  // =========================================================
  //  B. 牌阵选择 / 模型选择
  // =========================================================
  function renderSpreads() {
    const host = $("#spread-grid");
    host.innerHTML = "";
    state.spreads.forEach((s) => {
      const el = document.createElement("div");
      el.className = "spread-card" + (s.id === state.spreadId ? " active" : "");
      el.dataset.id = s.id;
      el.innerHTML = `
        <div class="sc-name">${s.name}<span class="sc-count">${s.count}张</span></div>
        <div class="sc-desc">${s.desc}</div>`;
      el.addEventListener("click", () => {
        state.spreadId = s.id;
        $$(".spread-card").forEach((x) =>
          x.classList.toggle("active", x.dataset.id === s.id)
        );
        applySpread(s.id);
      });
      host.appendChild(el);
    });
  }

  function renderModels() {
    const sel = $("#model-select");
    sel.innerHTML = "";
    state.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name}  [${m.speed}] · ${m.pick}`;
      sel.appendChild(opt);
      if (m.id === "glm-4.6v-flash") sel.value = m.id;
    });
    state.modelId = sel.value;
    sel.addEventListener("change", () => (state.modelId = sel.value));
  }

  // ---- 清除旧 spread 样式，应用新牌阵 ----
  function applySpread(id) {
    const sp = state.spreads.find((s) => s.id === id);
    if (!sp) return;
    const area = $("#cards-area");
    // 清理旧 spread class
    area.className = area.className.replace(/\bspread-\S+/g, "").trim();
    area.classList.add("spread-" + sp.id);
    renderCardPlaceholders(sp);
  }

  function renderCardPlaceholders(sp) {
    const host = $("#cards-area");
    host.innerHTML = "";
    sp.positions.forEach((p, i) => {
      const d = document.createElement("div");
      d.className = "card-placeholder";
      d.dataset.spotIdx = i;
      d.innerHTML = `<div class="pos-label">${p.label}</div><div class="pos-hint">${p.hint || ""}</div>`;
      host.appendChild(d);
    });
    $("#cards-title").textContent = `🎴 ${sp.name} · 共 ${sp.count} 张`;
    $("#deck-slot").hidden = true;
    setReadBtnDisabled(true, "✨ 请先抽牌");
    state.drawn = [];
  }

  // =========================================================
  //  C. 抽牌 + 牌阵布局
  // =========================================================
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function onDraw() {
    const sp = state.spreads.find((s) => s.id === state.spreadId);
    state.deck = shuffle(state.cards);
    const need = sp.count;
    if (state.deck.length < need) { setStatus("err", "牌库不足"); return; }

    // ---- 如果上一次解读还在跑, 先关掉 ----
    teardownPreviousReading({ silent: true });

    state.drawn = [];
    for (let i = 0; i < need; i++) {
      const c = state.deck[i];
      const upright = Math.random() < 0.5;
      state.drawn.push({ card: c, upright: upright });
    }
    $("#deck-left").textContent = state.deck.length - need;
    $("#deck-slot").hidden = false;

    // 渲染真实卡片 (每一张按 spotIdx 占位的位置, 若是专用布局会被CSS放到对应位置)
    const host = $("#cards-area");
    host.innerHTML = "";
    // 保持 spread-* class
    if (!host.classList.contains("spread-" + sp.id)) {
      host.classList.add("spread-" + sp.id);
    }

    sp.positions.forEach((p, i) => {
      const { card, upright } = state.drawn[i];
      const slot = document.createElement("div");
      slot.className = "card-slot";
      slot.dataset.spotIdx = i;
      slot.dataset.spotLabel = p.label;
      slot.innerHTML = `
        <div class="spot-caption">${p.label}</div>
        <div class="card${upright ? "" : " reversed"}">
          <div class="card-inner">
            <div class="card-back-face"></div>
            <div class="card-face">
              <img src="/static/card/${encodeURI(card.image)}" alt="${card.name}" loading="lazy"/>
              <div class="card-meta">
                <span>${card.name}</span>
                <span class="pos-tag ${upright ? "upright" : "reversed"}">${upright ? "正位" : "逆位"}</span>
              </div>
            </div>
          </div>
        </div>`;
      host.appendChild(slot);
      const cardEl = slot.querySelector(".card");
      setTimeout(() => cardEl && cardEl.classList.add("flipped"), 150 + i * 260);
    });

    setReadBtnDisabled(false, "🌟 请 AI 解读这组牌");
    $("#reset-btn").hidden = false;
    // 重置解读框为 placeholder
    renderReadingPlaceholder(sp);
    setStatus("ok", `抽牌完成：${sp.count} 张。可以解读，也可以重抽。`);
  }

  function onReset() {
    teardownPreviousReading({ silent: true });
    applySpread(state.spreadId);
    $("#reset-btn").hidden = true;
    const sp = state.spreads.find((s) => s.id === state.spreadId);
    renderReadingPlaceholder(sp);
    setStatus("", "");
  }

  function renderReadingPlaceholder(sp) {
    $("#reading").innerHTML = `
      <div class="placeholder">
        <div class="orb"></div>
        <p>抽好牌后，点下方按钮让 AI 为你解读${sp ? "（" + sp.name + "）" : ""}</p>
        <button id="read-btn" class="primary-btn" disabled disabled-state>✨ 请先抽牌</button>
      </div>`;
  }

  // =========================================================
  //  D. 解读生命周期: 等待动效 / AbortController / SSE
  // =========================================================
  function teardownPreviousReading({ silent }) {
    // 1) 取消旧 fetch 流, 立刻释放 TCP / 停止喂 token
    if (state.abortCtrl && typeof state.abortCtrl.abort === "function") {
      try { state.abortCtrl.abort(); } catch (_) {}
    }
    state.abortCtrl = null;
    // 2) 清轮播定时器
    if (state.rotateTimer) { clearInterval(state.rotateTimer); state.rotateTimer = null; }
    // 3) readingId 自增, 旧流里的 myReadId 会对不上 → 立刻停止写 DOM
    state.readingId++;
    // 4) 状态归零, 移除 mini indicator
    state.readingState = "idle";
    if (!silent) { /* 占位, 后续如需动画可扩展 */ }
  }

  function setReadBtnDisabled(disabled, text) {
    const btn = document.getElementById("read-btn");
    if (!btn) return;
    btn.disabled = !!disabled;
    if (disabled) btn.setAttribute("disabled-state", ""); else btn.removeAttribute("disabled-state");
    if (text) btn.textContent = text;
  }

  // ---- 渲染"等待大盒子" (TTFB 之前) ----
  function renderWaitingBanner(host, spName, modelName) {
    host.innerHTML = `
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
          <div class="waiting-sub">牌阵：${spName} · 模型：${modelName}</div>
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

    // 渲染 5 句等待文案, 只有当前句高亮, 前几句灰掉 (像步骤清单)
    const ul = document.getElementById("wait-steps");
    WAITING_STEPS.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "step" + (i === 0 ? " active" : "");
      li.dataset.stepIdx = i;
      li.innerHTML = `<span class="step-ic">${s.icon}</span><span class="step-tx">${s.text}</span><span class="step-dot"></span>`;
      ul.appendChild(li);
    });
    let cur = 0;
    const allLi = ul.querySelectorAll(".step");
    state.rotateTimer = setInterval(() => {
      allLi[cur].classList.remove("active");
      allLi[cur].classList.add("done");
      cur = (cur + 1) % WAITING_STEPS.length;
      allLi.forEach((x, i) => {
        if (i === cur) { x.classList.add("active"); x.classList.remove("done"); }
      });
    }, 2600);
  }

  // ---- 收到首字节: 缩小 waiting banner → mini indicator → 显示文本框开始写 ----
  function transitionToStreaming() {
    const waitBox = document.getElementById("wait-box");
    const mini = document.getElementById("stream-mini");
    const box = document.getElementById("read-box");
    if (waitBox) {
      waitBox.classList.add("shrink");
      setTimeout(() => { waitBox.style.display = "none"; }, 420);
    }
    if (box) box.style.display = "";
    if (mini) mini.style.display = "";
    state.readingState = "streaming";
  }

  async function onRead() {
    const q = $("#question").value.trim();
    if (!q) { setStatus("err", "请先输入你想问的问题（2 个字以上）"); $("#question").focus(); return; }
    if (state.drawn.length === 0) { setStatus("err", "请先抽牌"); return; }
    const sp = state.spreads.find((s) => s.id === state.spreadId);

    // ---- 先关掉前一次解读 (TCP abort + 清定时器 + readingId++) ----
    teardownPreviousReading({ silent: true });
    const myReadId = state.readingId;  // 记录本次 id, teardown 已经 +1, 就是当前值
    const ctrl = new AbortController();
    state.abortCtrl = ctrl;

    const modelObj = state.models.find((m) => m.id === state.modelId) || {};
    const modelName = modelObj.name || state.modelId;

    // ---- 渲染等待动效大盒子 ----
    const host = $("#reading");
    state.readingState = "waiting";
    renderWaitingBanner(host, sp.name, modelName);
    const metaBox = document.getElementById("read-meta");
    metaBox.innerHTML = `
      <span class="chip">牌阵：${sp.name}</span>
      <span class="chip">模型：${modelName}</span>
      <span class="chip" id="elapsed-chip">用时：0s</span>`;

    setReadBtnDisabled(true, "🔮 解读中…可点「重来一次」取消");
    setStatus("", "灵视开启，一边等待一边看步骤提示吧～");

    const t0 = Date.now();
    const tickTimer = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      const el = document.getElementById("elapsed-chip");
      if (el) el.textContent = `用时：${sec}s`;
    }, 500);

    let gotFirstText = false;
    let gotText = false;
    let done = false;
    let buf = "";

    try {
      const resp = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          question: q,
          spread_id: sp.id,
          model_id: state.modelId,
          positions: sp.positions,
          cards: state.drawn.map((d, i) => ({
            name: d.card.name,
            image: d.card.image,
            upright: d.upright,
            position: sp.positions[i] ? sp.positions[i].label : "",
          })),
        }),
      });
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
              if (!gotFirstText) {
                gotFirstText = true;
                transitionToStreaming();
              }
              // 写文本
              const inner = document.getElementById("rb-inner");
              const caret = document.querySelector("#read-box .caret");
              if (inner && state.readingId === myReadId) {
                inner.appendChild(document.createTextNode(j.text));
                gotText = true;
                if (caret) caret.scrollIntoView({ behavior: "smooth", block: "end" });
              }
            }
            if (j.done) done = true;
          } catch (e2) {
            // 非 JSON data 跳过; 真错误被 if(!j.ok) throw 在上一句
            if (e2 && e2.message && e2.message.includes("牌库中找不到")) throw e2;
          }
        }
      }

      if (state.readingId === myReadId) {
        cleanupAfterRead();
        const sec = Math.round((Date.now() - t0) / 1000);
        const el = document.getElementById("elapsed-chip");
        if (el) el.textContent = `用时：${sec}s`;
        if (gotText) {
          setStatus("ok", `解读完成（${sec}s）。可以换模型或牌阵再测。`);
        } else if (!ctrl.signal.aborted) {
          setStatus("err", "模型未返回任何文本，请重试或更换模型。");
        }
      }
    } catch (e) {
      if (state.readingId !== myReadId) {
        // 被新解读 abort 掉的, 直接静默 return
        return;
      }
      cleanupAfterRead();
      const aborted = e && (e.name === "AbortError" || ctrl.signal.aborted);
      if (aborted) {
        // 被 teardown 主动取消, 不红字
        setStatus("", "已取消上一次解读。");
      } else {
        const inner = document.getElementById("rb-inner");
        if (inner) {
          // 无论是否首字节已到, 都切到文本框便于用户看到错误
          const box = document.getElementById("read-box");
          if (box) box.style.display = "";
          const wait = document.getElementById("wait-box");
          if (wait) wait.style.display = "none";
          inner.appendChild(document.createTextNode("\n\n[出错] " + e.message));
        }
        setStatus("err", "解读失败：" + e.message);
      }
    } finally {
      if (state.readingId === myReadId) clearInterval(tickTimer);
      if (state.readingId === myReadId) {
        setReadBtnDisabled(false, "🌟 再解读一次");
      }
    }

    function cleanupAfterRead() {
      state.readingState = "done";
      if (state.rotateTimer) { clearInterval(state.rotateTimer); state.rotateTimer = null; }
      const caret = document.querySelector("#read-box .caret");
      if (caret) caret.remove();
      const mini = document.getElementById("stream-mini");
      if (mini) { mini.classList.add("fade-out"); setTimeout(() => mini && (mini.style.display = "none"), 400); }
      state.abortCtrl = null;
    }
  }

  // =========================================================
  //  E. 状态栏
  // =========================================================
  function setStatus(kind, text) {
    const s = $("#status");
    s.className = "status" + (kind ? " " + kind : "");
    s.textContent = text || "";
  }
})();
