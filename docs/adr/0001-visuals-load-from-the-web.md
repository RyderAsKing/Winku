# Visuals may load from the web

A visual is HTML the model writes, and it runs in a sandboxed frame on its own origin with a CSP of its own. That frame may load pictures and scripts from remote URLs. We chose this over two alternatives. One was no network at all, with the model writing plain SVG and canvas. The other was a small set of bundled libraries. Remote loads let the model use chart and diagram libraries it already knows, and they keep the app small. The cost is that Winku is no longer something that talks only to the model provider and Brave Search: a visual's loads reveal your IP to whatever hosts them, and a visual in History can change or break if a remote file does. The privacy page says so. The sandbox, rather than the network rule, is what keeps a page away from the app, the disk and the thread.

## Consequences

- The main webview's CSP (`default-src 'self'`) stays strict. Visuals cannot be `srcdoc` iframes, because those inherit it, so they are served from their own URL scheme.
- Taking network access away later would break visuals already saved in History that depend on it.
