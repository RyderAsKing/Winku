# Memory is put in front of the model, not looked up by it

Until 0.1.11 the model saw only a one-line index of its memory and had to call `memory_read` to see a note. On an ordinary question it rarely did, so it answered without what it knew about the user. Now the app does the work. A small memory block (About me, profile, goals, recap, note topics) is in every system prompt. Before each message, the engine searches the notes and adds the related ones to that message. A background tidy pass keeps the profile and goals current. The markdown files stay the only source of truth. The search index is a SQLite file under `engine\`, with FTS5 for keywords and vectors stored as blobs, and it is rebuilt from the files whenever they change. So editing a note by hand, Undo and Forget everything keep working the way they did.

## Considered options

- **SQLite as the store** (with SQLCipher). Rejected because it would break the promise that memory is plain markdown you can edit. Encrypting one file would also protect little while the rest of the data folder is plain text.
- **sqlite-vec for vector search.** Not needed. A few thousand notes × 384 floats is a brute-force scan of a few milliseconds in the engine, which is the same thing sqlite-vec 0.1 does, and it saves shipping and loading a native extension in the Bun binary.
- **Embedding in the engine** (transformers.js with onnxruntime-web or onnxruntime-node). Rejected: it adds a WASM runtime or a native addon to the compiled engine. The shell already links ONNX Runtime 1.28 statically through sherpa-onnx, so it runs bge-small-en-v1.5 on that runtime (`ort` with `alternative-backend`, pointed at the runtime's `OrtGetApiBase`). That takes about 2 ms a query and adds no native library. The engine asks for vectors with an `embed` Request.
- **Static embeddings** (model2vec). Faster and smaller, but noticeably worse at retrieval.

## Consequences

- The `ort` crate version must speak an API version the bundled ONNX Runtime serves (`api-24` against 1.28). Check this when upgrading sherpa-onnx.
- Recalled notes are part of the user message as stored in the session, so they are cached with it and survive a restart. The transcript strips them out, the same way it strips the now line.
- Tidy spends tokens on the Quick actions model. It is on by default and can be turned off.
