//! Memory search: the engine keeps the user's memory notes and asks the shell for sentence
//! embeddings (`embed` Requests) to find the ones relevant to a message. The model,
//! bge-small-en-v1.5, downloads on first use like the voice models and runs on the ONNX Runtime
//! sherpa-onnx already brings (see `embedder`).
//!
//! Like the voice models it loads on demand and unloads after `stt::IDLE_UNLOAD` idle; summoning
//! the bar or holding to talk loads it ahead of the message (`warm`). Inference runs on the
//! thread the engine's Request gets, never on the read loop, the hotkey handler or the UI.

pub mod embedder;
pub mod wordpiece;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::Store;
use crate::voice::download::{self, Downloads};
use crate::voice::models::{self, Asset, Kind, Model, Recipe, Unpack};
use crate::voice::stt::Slot;
use embedder::Embedder;

/// bge's instruction for short queries that search longer passages.
pub const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
/// Error text for an `embed` Request while the model isn't on disk (its download has started).
pub const NOT_READY: &str = "embedder_not_ready";
/// Error text for an `embed` Request while memory recall is off in settings.
pub const RECALL_OFF: &str = "recall_off";
/// How often the idle check runs while the model is loaded.
const JANITOR_INTERVAL: Duration = Duration::from_secs(20);

/// A file of Xenova/bge-small-en-v1.5 on Hugging Face, pinned to a commit.
macro_rules! bge {
    ($path:literal) => {
        concat!(
            "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/",
            $path
        )
    };
}

/// Kept out of `voice::models::MODELS`, so Settings doesn't list it with the voice models.
pub static MODEL: Model = Model {
    id: "bge-small-en-v1.5",
    kind: Kind::Embed,
    name: "Memory search (bge-small)",
    assets: &[
        Asset {
            url: bge!("onnx/model_quantized.onnx"),
            sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
            size: 34_014_426,
            unpack: Unpack::File("model.onnx"),
        },
        Asset {
            url: bge!("vocab.txt"),
            sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
            size: 231_508,
            unpack: Unpack::File("vocab.txt"),
        },
    ],
    recipe: Recipe::Embedder {
        model: "model.onnx",
        vocab: "vocab.txt",
    },
};

/// Managed state: the loaded model, its download and the idle thread.
#[derive(Default)]
pub struct Recall {
    slot: Mutex<Slot<Embedder>>,
    downloads: Downloads,
    janitor: AtomicBool,
    warming: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn models_dir(app: &AppHandle) -> PathBuf {
    models::models_dir(&app.state::<Store>().data_dir)
}

fn recall_on(app: &AppHandle) -> bool {
    app.state::<Store>().get().memory.recall
}

fn load(dir: &std::path::Path) -> Result<Embedder, String> {
    let Recipe::Embedder { model, vocab } = MODEL.recipe else {
        unreachable!("MODEL is an embedder");
    };
    Embedder::load(&dir.join(model), &dir.join(vocab)).map_err(|e| {
        eprintln!("winku: memory search model: {e}");
        format!(
            "{} couldn't be loaded; try removing and downloading it again",
            MODEL.name
        )
    })
}

// ───────────────────────────── embed Requests ─────────────────────────────

/// The parameters of an `embed` Request: `{ texts: string[], query: boolean }`.
#[derive(Debug, PartialEq)]
pub struct EmbedParams {
    pub texts: Vec<String>,
    pub query: bool,
}

pub fn parse_params(params: &Value) -> Result<EmbedParams, String> {
    let texts = params["texts"]
        .as_array()
        .ok_or("embed: texts must be an array of strings")?
        .iter()
        .map(|t| t.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
        .ok_or("embed: texts must be an array of strings")?;
    Ok(EmbedParams {
        texts,
        query: params["query"].as_bool().unwrap_or(false),
    })
}

/// The texts as the model reads them: queries get bge's search instruction.
pub fn model_inputs(params: EmbedParams) -> Vec<String> {
    if !params.query {
        return params.texts;
    }
    params
        .texts
        .into_iter()
        .map(|t| format!("{QUERY_PREFIX}{t}"))
        .collect()
}

/// A vector as base64 (standard alphabet, padded) of its little-endian f32s.
pub fn encode_vector(vector: &[f32]) -> String {
    let bytes: Vec<u8> = vector.iter().flat_map(|x| x.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The Response data: `{ model, dims, vectors }`.
pub fn response_data(vectors: &[Vec<f32>]) -> Value {
    json!({
        "model": MODEL.id,
        "dims": embedder::DIMENSIONS,
        "vectors": vectors.iter().map(|v| encode_vector(v)).collect::<Vec<_>>(),
    })
}

/// Answers an `embed` Request. Blocks while the model loads and runs: call it on a worker thread.
pub fn embed_request(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let params = parse_params(params)?;
    if !recall_on(app) {
        return Err(RECALL_OFF.into());
    }
    let dir = models_dir(app);
    if !MODEL.installed(&dir) {
        ensure_download(app);
        return Err(NOT_READY.into());
    }
    let texts = model_inputs(params);
    let recall = app.state::<Recall>();
    let model_dir = MODEL.dir(&dir);
    let vectors = {
        let mut slot = lock(&recall.slot);
        let result = slot
            .get_or_load_mut(MODEL.id, Instant::now(), || load(&model_dir))
            .and_then(|embedder| embedder.embed(&texts));
        slot.touch(Instant::now());
        result
    };
    ensure_janitor(app);
    Ok(response_data(&vectors?))
}

// ───────────────────────────── warm-up ─────────────────────────────

/// The bar was summoned or a hold started: with recall on and the model on disk, load it on a
/// background thread so the message's first `embed` doesn't wait for it. Returns at once.
pub fn warm(app: &AppHandle) {
    let Some(recall) = app.try_state::<Recall>() else {
        return;
    };
    if recall.warming.swap(true, Ordering::SeqCst) {
        return;
    }
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-recall-warm".into())
        .spawn(move || {
            let app = thread_app;
            let recall = app.state::<Recall>();
            let dir = models_dir(&app);
            if recall_on(&app) && MODEL.installed(&dir) {
                let model_dir = MODEL.dir(&dir);
                let loaded = {
                    let mut slot = lock(&recall.slot);
                    let loaded = slot
                        .get_or_load_mut(MODEL.id, Instant::now(), || load(&model_dir))
                        .is_ok();
                    slot.touch(Instant::now());
                    loaded
                };
                if loaded {
                    ensure_janitor(&app);
                }
            }
            recall.warming.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        recall.warming.store(false, Ordering::SeqCst);
    }
}

/// Recall was turned off: free the model now instead of waiting for the idle unload.
pub fn unload(app: &AppHandle) {
    let app = app.clone();
    // The slot may be busy with a run; don't hold up the caller for it.
    let _ = std::thread::Builder::new()
        .name("winku-recall-unload".into())
        .spawn(move || lock(&app.state::<Recall>().slot).unload(MODEL.id));
}

// ───────────────────────────── the model on disk ─────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub size_mb: u64,
    pub installed: bool,
    pub downloading: bool,
}

/// `memory_model_status`.
pub fn status(app: &AppHandle) -> ModelStatus {
    ModelStatus {
        id: MODEL.id,
        name: MODEL.name,
        size_mb: MODEL.size_mb(),
        installed: MODEL.installed(&models_dir(app)),
        downloading: app.state::<Recall>().downloads.is_active(MODEL.id),
    }
}

/// `memory_model_remove`: unloads the model and deletes its folder.
pub fn remove(app: &AppHandle) -> Result<(), String> {
    let recall = app.state::<Recall>();
    if recall.downloads.is_active(MODEL.id) {
        return Err(format!("{} is still downloading", MODEL.name));
    }
    lock(&recall.slot).unload(MODEL.id);
    let dir = MODEL.dir(&models_dir(app));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Couldn't remove {}: {e}", MODEL.name))?;
    }
    Ok(())
}

fn progress(app: &AppHandle, fraction: f32) {
    let _ = app.emit(
        crate::voice::DOWNLOAD_EVENT,
        json!({ "what": MODEL.kind.as_str(), "model": MODEL.id, "fraction": fraction }),
    );
}

/// Starts downloading the model on its own thread unless it is installed or already
/// downloading (`memory_model_download`, and the first `embed` without it). Progress goes out
/// as `download_progress`; a failure is logged, not shown: memory search just stays off until
/// the next try.
pub fn ensure_download(app: &AppHandle) {
    let recall = app.state::<Recall>();
    let dir = models_dir(app);
    if MODEL.installed(&dir) || !recall.downloads.begin(MODEL.id) {
        return;
    }
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-download".into())
        .spawn(move || {
            let app = thread_app;
            if let Err(e) = std::fs::create_dir_all(&dir) {
                eprintln!("winku: creating {}: {e}", dir.display());
            }
            progress(&app, 0.0);
            let result =
                download::install(&MODEL, &dir, &download::Https, &mut |f| progress(&app, f));
            match result {
                Ok(()) => progress(&app, 1.0),
                Err(e) => {
                    eprintln!("winku: {}", e.message(&MODEL));
                    progress(&app, -1.0);
                }
            }
            app.state::<Recall>().downloads.finish(MODEL.id);
        });
    if let Err(e) = spawned {
        recall.downloads.finish(MODEL.id);
        eprintln!("winku: couldn't start the memory search download: {e}");
    }
}

// ───────────────────────────── idle unload ─────────────────────────────

/// While the model is loaded, a thread checks every `JANITOR_INTERVAL` and drops it once idle
/// for `stt::IDLE_UNLOAD`; it exits once nothing is loaded.
fn ensure_janitor(app: &AppHandle) {
    let recall = app.state::<Recall>();
    if recall.janitor.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-recall-idle".into())
        .spawn(move || {
            let recall = app.state::<Recall>();
            loop {
                std::thread::sleep(JANITOR_INTERVAL);
                if recall.sweep(Instant::now()) {
                    continue;
                }
                recall.janitor.store(false, Ordering::SeqCst);
                // A load between the sweep and the store must still get a janitor.
                if recall.sweep(Instant::now()) && !recall.janitor.swap(true, Ordering::SeqCst) {
                    continue;
                }
                break;
            }
        });
    if spawned.is_err() {
        recall.janitor.store(false, Ordering::SeqCst);
    }
}

impl Recall {
    /// Unloads the model if idle. True while it is still loaded (or busy).
    fn sweep(&self, now: Instant) -> bool {
        match self.slot.try_lock() {
            Ok(mut slot) => {
                if slot.unload_if_idle(now) {
                    eprintln!("winku: memory search model unloaded after idling");
                }
                slot.is_loaded()
            }
            Err(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_downloads_two_pinned_files() {
        assert_eq!(MODEL.files(), ["model.onnx", "vocab.txt"]);
        assert_eq!(MODEL.size_mb(), 34);
        assert_eq!(MODEL.kind.as_str(), "embed");
        for asset in MODEL.assets {
            assert!(asset.url.starts_with(
                "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/"
            ));
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
        assert!(
            models::find(MODEL.id).is_none(),
            "not listed with the voice models"
        );
    }

    #[test]
    fn parses_params() {
        assert_eq!(
            parse_params(&json!({ "texts": ["a", "b"], "query": true })),
            Ok(EmbedParams {
                texts: vec!["a".into(), "b".into()],
                query: true
            })
        );
        assert_eq!(
            parse_params(&json!({ "texts": [] })),
            Ok(EmbedParams {
                texts: vec![],
                query: false
            })
        );
        assert!(parse_params(&json!({})).is_err());
        assert!(parse_params(&json!({ "texts": "a" })).is_err());
        assert!(parse_params(&json!({ "texts": ["a", 1] })).is_err());
    }

    #[test]
    fn queries_get_the_search_instruction() {
        let texts = vec!["Where does Rajat live?".to_string()];
        assert_eq!(
            model_inputs(EmbedParams {
                texts: texts.clone(),
                query: true
            }),
            ["Represent this sentence for searching relevant passages: Where does Rajat live?"]
        );
        assert_eq!(
            model_inputs(EmbedParams {
                texts: texts.clone(),
                query: false
            }),
            texts
        );
    }

    #[test]
    fn vectors_are_base64_little_endian_f32() {
        assert_eq!(encode_vector(&[1.0]), "AACAPw==");
        let vector: Vec<f32> = (0..embedder::DIMENSIONS).map(|i| i as f32 / 7.0).collect();
        let data = response_data(std::slice::from_ref(&vector));
        assert_eq!(data["model"], "bge-small-en-v1.5");
        assert_eq!(data["dims"], 384);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data["vectors"][0].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes.len(), 384 * 4);
        let back: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        assert_eq!(back, vector);
        assert_eq!(response_data(&[])["vectors"], json!([]));
    }
}

#[cfg(test)]
mod e2e {
    use super::*;

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    /// The real model, so not part of `cargo test`. Run with
    /// `WINKU_EMBED_E2E=/some/dir cargo test --release recall::e2e -- --ignored --nocapture`,
    /// where the folder holds model.onnx (bge-small-en-v1.5's onnx/model_quantized.onnx) and
    /// vocab.txt. Loads a sherpa-onnx voice model first when `WINKU_VOICE_E2E` points at a folder
    /// with Supertonic installed, so both use the one ONNX Runtime in the same process.
    #[test]
    #[ignore]
    fn finds_the_relevant_note() {
        let Some(dir) = std::env::var_os("WINKU_EMBED_E2E").map(PathBuf::from) else {
            eprintln!("WINKU_EMBED_E2E not set; skipping");
            return;
        };
        let rss = || {
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("VmRSS"))
                        .map(str::to_string)
                })
                .unwrap_or_default()
        };
        // sherpa-onnx's own ORT environment and sessions, before ours.
        let voice_dir = std::env::var_os("WINKU_VOICE_E2E").map(PathBuf::from);
        let sherpa = voice_dir.as_ref().and_then(|voice| {
            let model = models::find("supertonic").unwrap();
            model.installed(voice).then(|| {
                crate::voice::tts::load_supertonic(model, &model.dir(voice)).expect("supertonic")
            })
        });
        eprintln!("sherpa-onnx loaded: {}", sherpa.is_some());

        let mut slot: Slot<Embedder> = Slot::default();
        for round in 0..2 {
            let started = Instant::now();
            let embedder = slot
                .get_or_load_mut(MODEL.id, Instant::now(), || load(&dir))
                .unwrap();
            eprintln!("round {round}: load {:?}, {}", started.elapsed(), rss());
            let query = model_inputs(EmbedParams {
                texts: vec!["Where does Rajat live?".into()],
                query: true,
            });
            let started = Instant::now();
            let q = embedder.embed(&query).unwrap().remove(0);
            eprintln!("query {:?}", started.elapsed());
            let notes: Vec<String> = [
                "Rajat lives in Berlin",
                "The cat sat on the mat",
                "Rajat prefers short replies",
            ]
            .map(String::from)
            .to_vec();
            let started = Instant::now();
            let vectors = embedder.embed(&notes).unwrap();
            eprintln!("{} notes {:?}", notes.len(), started.elapsed());
            for v in vectors.iter().chain([&q]) {
                assert_eq!(v.len(), embedder::DIMENSIONS);
                assert!((dot(v, v) - 1.0).abs() < 1e-4, "normalised");
            }
            let scores: Vec<f32> = vectors.iter().map(|v| dot(&q, v)).collect();
            eprintln!("scores {scores:?}");
            assert!(scores[0] > scores[1], "{scores:?}");
            assert!(scores[0] > scores[2], "{scores:?}");
            // A batch gives nearly the same vectors as one at a time. Not exactly: the int8
            // model quantises activations with scales taken over the whole batch (measured
            // 0.997 here).
            let alone = embedder.embed(&notes[1..2]).unwrap().remove(0);
            let same = dot(&alone, &vectors[1]);
            eprintln!("alone vs in a batch: {same}");
            assert!(same > 0.99, "{same}");
            // Unload and load again: the second round builds a new session on the kept
            // environment.
            slot.unload(MODEL.id);
        }

        if let Some(engine) = sherpa {
            // sherpa-onnx still works after our environment and sessions came and went.
            let feed = crate::voice::tts::Feed::new(crate::voice::tts::engine_rate(&engine));
            let stop = std::sync::atomic::AtomicBool::new(false);
            let mut utterance = crate::voice::tts::Utterance::default();
            crate::voice::tts::supertonic_speak(
                &engine,
                "Memory search works.",
                crate::voice::tts::Reading::default(),
                &mut utterance,
                &feed,
                &stop,
            );
            let samples = feed.take_all();
            eprintln!("supertonic after: {} samples", samples.len());
            assert!(samples.len() > 1000);
        }
    }
}
