(() => {
  if (window.__ROYAL_PALACE_CHAT_UI__) return;
  window.__ROYAL_PALACE_CHAT_UI__ = true;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/chat-ui.css";
  document.head.appendChild(css);

  function mount() {
    const logout = [...document.querySelectorAll("button, a")]
      .find(el => (el.textContent || "").trim().toUpperCase() === "LOGOUT");
    if (!logout || !logout.parentElement) return false;

    const root = document.createElement("div");
    root.id = "rp-chat-root";
    root.innerHTML = `
      <button id="rp-chat-trigger" type="button" aria-expanded="false" aria-controls="rp-chat-panel">
        <span aria-hidden="true">✉</span> MESSAGE
        <span id="rp-chat-unread">0</span>
      </button>
      <section id="rp-chat-panel" role="dialog" aria-label="Royal Palace chat">
        <header class="rp-chat-head">
          <span>ROYAL CHAT</span>
          <button id="rp-chat-close" type="button" aria-label="Close chat">×</button>
        </header>
        <div class="rp-chat-status">MESSAGE ROOM · UI PREVIEW</div>
        <div id="rp-chat-messages" aria-live="polite">
          <div class="rp-chat-message rp-system">
            <div class="rp-chat-meta">SYSTEM</div>
            <div class="rp-chat-bubble">채팅 UI가 준비되었습니다.</div>
          </div>
        </div>
        <form class="rp-chat-compose" id="rp-chat-form">
          <input id="rp-chat-input" maxlength="300" autocomplete="off"
            placeholder="메시지를 입력하세요..." aria-label="Message">
          <button id="rp-chat-send" type="submit">SEND</button>
        </form>
        <div class="rp-chat-note">현재 버전은 화면 UI 미리보기입니다. 다른 플레이어와 실시간으로 연결하려면 서버 연동이 필요합니다.</div>
      </section>
    `;

    logout.parentElement.insertBefore(root, logout);

    const trigger = root.querySelector("#rp-chat-trigger");
    const panel = root.querySelector("#rp-chat-panel");
    const close = root.querySelector("#rp-chat-close");
    const form = root.querySelector("#rp-chat-form");
    const input = root.querySelector("#rp-chat-input");
    const messages = root.querySelector("#rp-chat-messages");
    const unread = root.querySelector("#rp-chat-unread");

    function setOpen(open) {
      panel.classList.toggle("rp-open", open);
      trigger.setAttribute("aria-expanded", String(open));
      if (open) {
        unread.style.display = "none";
        unread.textContent = "0";
        input.focus();
      }
    }
    trigger.addEventListener("click", () => setOpen(!panel.classList.contains("rp-open")));
    close.addEventListener("click", () => setOpen(false));

    function addMessage(name, text, system = false) {
      const item = document.createElement("div");
      item.className = "rp-chat-message" + (system ? " rp-system" : "");
      const meta = document.createElement("div");
      meta.className = "rp-chat-meta";
      meta.textContent = name;
      const bubble = document.createElement("div");
      bubble.className = "rp-chat-bubble";
      bubble.textContent = text;
      item.append(meta, bubble);
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
      if (!panel.classList.contains("rp-open")) {
        unread.style.display = "inline-flex";
        unread.textContent = String(Math.min(99, Number(unread.textContent || 0) + 1));
      }
    }

    form.addEventListener("submit", event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const playerName = localStorage.getItem("username") ||
        localStorage.getItem("nickname") || "PLAYER";
      addMessage(playerName, value);
      input.value = "";
      input.focus();
    });

    // UI preview only: no network request and no shared messages.
    window.RoyalPalaceChatUI = {
      addSystemMessage(message) { addMessage("SYSTEM", String(message), true); },
      addPreviewMessage(name, message) { addMessage(String(name), String(message)); }
    };
    return true;
  }

  if (!mount()) {
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
