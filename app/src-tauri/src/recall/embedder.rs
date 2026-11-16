//! Sentence embeddings with bge-small-en-v1.5 (int8 ONNX) on the ONNX Runtime that sherpa-onnx
//! already links into the shell. `ort` is built with `alternative-backend`, so it links no
//! runtime of its own; `init_api` points it at the static one's API table instead.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use ort::environment::Environment;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use super::wordpiece::WordPiece;

/// Width of one vector.
pub const DIMENSIONS: usize = 384;
/// Tokens per text, [CLS] and [SEP] included. Memory notes are short; longer texts are cut.
pub const MAX_TOKENS: usize = 256;
/// Texts per inference run.
pub const BATCH: usize = 32;
/// Threads for one run: quick enough for a handful of notes without taking over the machine.
const INTRA_THREADS: usize = 2;

/// Hands `ort` the API table of the ONNX Runtime sherpa-onnx linked in. Once per process.
fn init_api() -> Result<(), String> {
    static API: OnceLock<Result<(), String>> = OnceLock::new();
    API.get_or_init(|| {
        // SAFETY: OrtGetApiBase is the entry point of the onnxruntime static library that
        // sherpa-onnx links (libonnxruntime.a, onnxruntime.lib on Windows). It returns a
        // pointer to a static table, and GetApi a pointer to a static OrtApi (or null for a
        // version the runtime doesn't serve), both valid for the life of the process.
        unsafe {
            let base = ort::sys::OrtGetApiBase();
            if base.is_null() {
                return Err("ONNX Runtime is missing".to_string());
            }
            let api = ((*base).GetApi)(ort::sys::ORT_API_VERSION);
            if api.is_null() {
                return Err("ONNX Runtime is too old for memory search".to_string());
            }
            ort::set_api(std::ptr::read(api));
        }
        Ok(())
    })
    .clone()
}

/// `ort` allows one Environment per process, ever (building a second fails even after the first
/// is dropped), so it is made once and kept for every later load. In ONNX Runtime it is the same
/// process-wide OrtEnv sherpa-onnx's sessions share, so keeping it costs next to nothing.
fn environment() -> Result<Environment, String> {
    static ENV: Mutex<Option<Environment>> = Mutex::new(None);
    let mut env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(env) = env.as_ref() {
        return Ok(env.clone());
    }
    let built = ort::init()
        .with_name("winku-recall")
        .with_telemetry(false)
        .build()
        .map_err(|e| e.to_string())?;
    *env = Some(built.clone());
    Ok(built)
}

pub struct Embedder {
    session: Session,
    tokenizer: WordPiece,
}

impl Embedder {
    pub fn load(model: &Path, vocab: &Path) -> Result<Self, String> {
        init_api()?;
        let vocab = std::fs::read_to_string(vocab).map_err(|e| format!("vocab.txt: {e}"))?;
        let tokenizer = WordPiece::from_vocab(&vocab)?;
        let env = environment()?;
        let session = Session::builder(&env)
            .and_then(|b| {
                b.with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(Into::into)
            })
            .and_then(|b| b.with_intra_threads(INTRA_THREADS).map_err(Into::into))
            .and_then(|mut b| b.commit_from_file(model))
            .map_err(|e| e.to_string())?;
        Ok(Self { session, tokenizer })
    }

    /// One L2-normalised vector per text, in order. Texts run in batches of `BATCH`, similar
    /// lengths together so short ones aren't padded to a long one.
    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let encoded: Vec<Vec<i64>> = texts.iter().map(|t| self.encode(t)).collect();
        let lengths: Vec<usize> = encoded.iter().map(Vec::len).collect();
        let mut vectors = vec![Vec::new(); texts.len()];
        for batch in batches(&lengths, BATCH) {
            let rows: Vec<&[i64]> = batch.iter().map(|&i| encoded[i].as_slice()).collect();
            for (i, vector) in batch.iter().zip(self.run(&rows)?) {
                vectors[*i] = vector;
            }
        }
        Ok(vectors)
    }

    /// [CLS] text [SEP], at most `MAX_TOKENS`.
    fn encode(&self, text: &str) -> Vec<i64> {
        let mut ids = vec![self.tokenizer.cls];
        ids.extend(self.tokenizer.encode(text, MAX_TOKENS - 2));
        ids.push(self.tokenizer.sep);
        ids
    }

    fn run(&mut self, rows: &[&[i64]]) -> Result<Vec<Vec<f32>>, String> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let (ids, mask, width) = pad(rows);
        let types = vec![0i64; ids.len()];
        let shape = [rows.len() as i64, width as i64];
        let tensor = |data: Vec<i64>| Tensor::from_array((shape, data)).map_err(|e| e.to_string());
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => tensor(ids)?,
                "attention_mask" => tensor(mask)?,
                "token_type_ids" => tensor(types)?,
            ])
            .map_err(|e| e.to_string())?;
        let (out_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let dims: Vec<usize> = out_shape.iter().map(|&d| d.max(0) as usize).collect();
        cls_vectors(data, &dims, rows.len())
    }
}

/// Row-major token ids and attention mask, every row padded with zeros to the longest.
fn pad(rows: &[&[i64]]) -> (Vec<i64>, Vec<i64>, usize) {
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut ids = vec![0i64; rows.len() * width];
    let mut mask = vec![0i64; rows.len() * width];
    for (row, tokens) in rows.iter().enumerate() {
        ids[row * width..row * width + tokens.len()].copy_from_slice(tokens);
        mask[row * width..row * width + tokens.len()].fill(1);
    }
    (ids, mask, width)
}

/// Indices of texts grouped into runs of at most `size`, ordered by token count.
fn batches(lengths: &[usize], size: usize) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..lengths.len()).collect();
    order.sort_by_key(|&i| lengths[i]);
    order.chunks(size.max(1)).map(<[usize]>::to_vec).collect()
}

/// The [CLS] token's hidden state of each row (bge's pooling), L2-normalised. `dims` is the
/// output's shape: [batch, sequence, hidden].
fn cls_vectors(data: &[f32], dims: &[usize], batch: usize) -> Result<Vec<Vec<f32>>, String> {
    let &[rows, seq, hidden] = dims else {
        return Err(format!("unexpected output shape {dims:?}"));
    };
    if rows != batch || hidden != DIMENSIONS || seq == 0 || data.len() < rows * seq * hidden {
        return Err(format!("unexpected output shape {dims:?}"));
    }
    Ok((0..rows)
        .map(|row| {
            let cls = &data[row * seq * hidden..row * seq * hidden + hidden];
            let norm = cls.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
            cls.iter().map(|x| x / norm).collect()
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_rows_and_masks_the_padding() {
        let (ids, mask, width) = pad(&[&[101, 7, 102], &[101, 102]]);
        assert_eq!(width, 3);
        assert_eq!(ids, [101, 7, 102, 101, 102, 0]);
        assert_eq!(mask, [1, 1, 1, 1, 1, 0]);
        assert_eq!(pad(&[]), (vec![], vec![], 0));
    }

    #[test]
    fn batches_group_similar_lengths_and_cover_every_text() {
        let lengths = [9, 2, 5, 2, 7];
        let runs = batches(&lengths, 2);
        assert_eq!(runs, [vec![1, 3], vec![2, 4], vec![0]]);
        assert!(batches(&[], BATCH).is_empty());
        let many = vec![4; 70];
        let runs = batches(&many, BATCH);
        assert_eq!(runs.iter().map(Vec::len).collect::<Vec<_>>(), [32, 32, 6]);
    }

    #[test]
    fn takes_the_cls_state_and_normalises_it() {
        // Two rows of two tokens; only the first token of each row counts.
        let mut data = vec![0.0f32; 2 * 2 * DIMENSIONS];
        data[0] = 3.0;
        data[1] = 4.0;
        data[DIMENSIONS] = 100.0; // second token of row 0: ignored
        data[2 * DIMENSIONS + 5] = -2.0;
        let vectors = cls_vectors(&data, &[2, 2, DIMENSIONS], 2).unwrap();
        assert_eq!(vectors.len(), 2);
        assert!((vectors[0][0] - 0.6).abs() < 1e-6);
        assert!((vectors[0][1] - 0.8).abs() < 1e-6);
        assert_eq!(vectors[1][5], -1.0);
        assert!(cls_vectors(&data, &[2, 2, 2 * DIMENSIONS], 1).is_err());
        assert!(cls_vectors(&data, &[4, DIMENSIONS], 4).is_err());
        assert!(cls_vectors(&data[..10], &[2, 2, DIMENSIONS], 2).is_err());
    }
}
