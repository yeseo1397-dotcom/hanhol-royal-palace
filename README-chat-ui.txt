# Royal Palace Chat UI (UI preview)

## Files
- `chat-ui.css`: black-and-gold chat styling
- `chat-ui.js`: adds a MESSAGE button immediately before the LOGOUT button and opens the chat panel

## Install
1. Upload `chat-ui.css` and `chat-ui.js` to the same folder served by your app's static web server (usually `public/`).
2. In the HTML page that contains the LOGOUT button (likely `lobby.html`), add this immediately before `</body>`:

```html
<script src="/chat-ui.js"></script>
```

3. Commit and push to GitHub, then let Render deploy.

If your static files are served from a different folder or URL prefix, update the CSS link path in `chat-ui.js` accordingly.

## Important
This package is a front-end UI preview. Messages are shown only in the current browser and are not shared with other players. Real multiplayer chat requires a server-side WebSocket/Socket.IO endpoint and server-side validation. No coin/betting result notifications are included.
