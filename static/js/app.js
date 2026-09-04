/* =====================================================
   塔罗解读前端: 抽牌 + SSE 流式渲染
   ===================================================== */
(function () {
  "use strict";

  // ---- 全局状态 ----
  const state = {
    cards: [],           // 从 /api/config 拉到的 78 张牌
    spreads: [],
    models: [],
    deck: [],            // 当前牌堆(已洗牌 未发牌池), card 对象引用
    drawn: [],           // 已抽牌 [{card, upright}]
    spreadId: "time3",
    modelId: "",
    readingId: 0,        // 每次解读自增，用于打断旧 SSE
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- 初始化配置 ----
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
    $("#read-btn").addEventListener("click", onRead);
    $("#question").addEventListener("input", () => {
      $("#q-count").textContent = $("#question").value.length;
    });
  }

  // ---- 渲染牌阵选择 ----
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
        $$(".spread-card").forEach((x) => x.classList.toggle("active", x.dataset.id === s.id));
        applySpread(s.id);
      });
      host.appendChild(el);
    });
  }

  function renderModels() {
    const sel = $("#model-select");
    sel.innerHTML = "";
    state.models.forEach((m, i) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name}  [${m.speed}] · ${m.pick}`;
      sel.appendChild(opt);
      if (m.id === "glm-4.6v-flash") sel.value = m.id;
    });
    state.modelId = sel.value;
    sel.addEventListener("change", () => (state.modelId = sel.value));
  }

  function applySpread(id) {
    const sp = state.spreads.find((s) => s.id === id);
    if (!sp) return;
    resetCardsUI();
    renderCardPlaceholders(sp);
  }

  // ---- 抽牌前占位格 ----
  function renderCardPlaceholders(sp) {
    const host = $("#cards-area");
    host.innerHTML = "";
    sp.positions.forEach((p) => {
      const d = document.createElement("div");
      d.className = "card-placeholder";
      d.innerHTML = `<div class="pos-label">${p.label}</div><div class="pos-hint">${p.hint || ""}</div>`;
      host.appendChild(d);
    });
    $("#cards-title").textContent = `🎴 ${sp.name} · 共 ${sp.count} 张`;
    $("#deck-slot").hidden = true;
    $("#read-btn").setAttribute("disabled-state", "");
    $("#read-btn").disabled = true;
    $("#read-btn").textContent = "✨ 请先抽牌";
    state.drawn = [];
  }

  function resetCardsUI() {
    // 下一次抽牌时自动重建
  }

  // ---- Fisher-Yates 洗牌 ----
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- 抽牌 ----
  async function onDraw() {
    const sp = state.spreads.find((s) => s.id === state.spreadId);
    state.deck = shuffle(state.cards);
    const need = sp.count;
    if (state.deck.length < need) { setStatus("err", "牌库不足"); return; }

    // 发牌
    state.drawn = [];
    for (let i = 0; i < need; i++) {
      const c = state.deck[i];
      const upright = Math.random() < 0.5;  // 50% 正/逆
      state.drawn.push({ card: c, upright: upright });
    }
    // 剩余牌堆
    const left = state.deck.length - need;
    $("#deck-left").textContent = left;
    $("#deck-slot").hidden = false;

    // 渲染卡背, 依次翻牌
    const host = $("#cards-area");
    host.innerHTML = "";
    sp.positions.forEach((p, i) => {
      const { card, upright } = state.drawn[i];
      const wrap = document.createElement("div");
      wrap.className = "card-wrap";
      wrap.style.cssText = "position: relative;";
      const el = document.createElement("div");
      el.className = "card" + (upright ? "" : " reversed");
      el.innerHTML = `
        <div class="card-inner">
          <div class="card-back-face"></div>
          <div class="card-face">
            <img src="/static/card/${encodeURI(card.image)}" alt="${card.name}" loading="lazy"/>
            <div class="card-meta">
              <span>${card.name}${p.label ? " · " + p.label : ""}</span>
              <span class="pos-tag ${upright ? "upright" : "reversed"}">${upright ? "正位" : "逆位"}</span>
            </div>
          </div>
        </div>`;
      host.appendChild(el);
      setTimeout(() => el.classList.add("flipped"), 120 + i * 260);
    });

    $("#read-btn").removeAttribute("disabled-state");
    $("#read-btn").disabled = false;
    $("#read-btn").textContent = "🌟 请 AI 解读这组牌";
    $("#reset-btn").hidden = false;
    setStatus("ok", `抽牌完成：${sp.count} 张。可以解读，也可以重抽。`);
  }

  function onReset() {
    applySpread(state.spreadId);
    $("#reset-btn").hidden = true;
    $("#reading").innerHTML = `
      <div class="placeholder">
        <div class="orb"></div>
        <p>抽好牌后，点下方按钮让 AI 为你解读</p>
        <button id="read-btn" class="primary-btn" disabled disabled-state>✨ 请先抽牌</button>
      </div>`;
    document.getElementById("read-btn").addEventListener("click", onRead);
    setStatus("", "");
  }

  // ---- 发起解读 (SSE) ----
  async function onRead() {
    const q = $("#question").value.trim();
    if (!q) { setStatus("err", "请先输入你想问的问题（2 个字以上）"); $("#question").focus(); return; }
    if (state.drawn.length === 0) { setStatus("err", "请先抽牌"); return; }
    const sp = state.spreads.find((s) => s.id === state.spreadId);

    state.readingId++;
    const myReadId = state.readingId;

    const host = $("#reading");
    host.innerHTML = `
      <div class="reading-content" id="read-box"></div>
      <div class="read-footer-meta" id="read-meta"></div>`;
    const box = document.getElementById("read-box");
    const meta = document.getElementById("read-meta");

    box.innerHTML = `<div id="rb-inner"></div><span class="caret"></span>`;
    const inner = document.getElementById("rb-inner");
    const caret = box.querySelector(".caret");

    const btn = $("#read-btn");
    btn.disabled = true;
    btn.setAttribute("disabled-state", "");
    btn.textContent = "🔮 正在连接智谱解读...";
    setStatus("", "模型调用中，一边流式输出一边看...");
    meta.innerHTML = `
      <span class="chip">牌阵：${sp.name}</span>
      <span class="chip">模型：${(state.models.find(m => m.id === state.modelId) || {}).name || state.modelId}</span>
      <span class="chip" id="elapsed-chip">用时：0s</span>`;

    const t0 = Date.now();
    const tickTimer = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      const el = document.getElementById("elapsed-chip");
      if (el) el.textContent = `用时：${sec}s`;
    }, 500);

    // 流式读取 SSE
    try {
      const resp = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      if (!resp.ok) {
        throw new Error("HTTP " + resp.status + " " + resp.statusText);
      }
      if (!resp.body) throw new Error("浏览器不支持 stream body");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let gotText = false;
      let done = false;

      while (!done) {
        const { value, done: d } = await reader.read();
        if (myReadId !== state.readingId) { break; } // 用户重开了新解读
        if (d) done = true;
        if (value) buf += decoder.decode(value, { stream: !done });
        // 拆分 SSE 事件行
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || "";
        for (const line of lines) {
          const ln = line.replace(/^data:\s*/, "").trim();
          if (!ln) continue;
          try {
            const j = JSON.parse(ln);
            if (!j.ok) {
              throw new Error(j.error || "解读失败");
            }
            if (typeof j.text === "string") {
              inner.appendChild(document.createTextNode(j.text));
              gotText = true;
              caret.scrollIntoView({ behavior: "smooth", block: "end" });
            }
            if (j.done) done = true;
          } catch (_e) { /* 非 JSON data 跳过 */ }
        }
      }

      if (myReadId === state.readingId) {
        caret.remove();
        clearInterval(tickTimer);
        const sec = Math.round((Date.now() - t0) / 1000);
        const el = document.getElementById("elapsed-chip");
        if (el) el.textContent = `用时：${sec}s`;
        btn.disabled = false; btn.removeAttribute("disabled-state");
        btn.textContent = "🌟 再解读一次";
        if (gotText) {
          setStatus("ok", `解读完成（${sec}s）。可以换模型或牌阵再测。`);
        } else {
          setStatus("err", "模型未返回任何文本，请重试或更换模型。");
        }
      }
    } catch (e) {
      if (myReadId !== state.readingId) return;
      clearInterval(tickTimer);
      inner.appendChild(document.createTextNode("\n\n[出错] " + e.message));
      caret && caret.remove();
      btn.disabled = false; btn.removeAttribute("disabled-state");
      btn.textContent = "🌟 请 AI 解读这组牌";
      setStatus("err", "解读失败：" + e.message);
    }
  }

  function setStatus(kind, text) {
    const s = $("#status");
    s.className = "status" + (kind ? " " + kind : "");
    s.textContent = text || "";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
