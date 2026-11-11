//! The voice model table: what each model downloads (pinned URLs, sizes and SHA-256s from the
//! k2-fsa/sherpa-onnx GitHub releases), which files it keeps, and where it lives on disk.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Stt,
    Tts,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Stt => "stt",
            Kind::Tts => "tts",
        }
    }
}

/// One file to download.
#[derive(Debug)]
pub struct Asset {
    pub url: &'static str,
    pub sha256: &'static str,
    /// Bytes, for progress.
    pub size: u64,
    pub unpack: Unpack,
}

#[derive(Debug)]
pub enum Unpack {
    /// A .tar.bz2: keep only these file names (wherever they sit in the archive).
    TarBz2(&'static [&'static str]),
    /// A plain file, saved under this name.
    File(&'static str),
}

/// How the model is wired into sherpa-onnx. File names are relative to the model folder.
#[derive(Debug)]
pub enum Recipe {
    Moonshine {
        encoder: &'static str,
        merged_decoder: &'static str,
        tokens: &'static str,
    },
    Whisper {
        encoder: &'static str,
        decoder: &'static str,
        tokens: &'static str,
    },
    Transducer {
        encoder: &'static str,
        decoder: &'static str,
        joiner: &'static str,
        tokens: &'static str,
    },
    Kokoro {
        model: &'static str,
        voices: &'static str,
        tokens: &'static str,
        lexicon: &'static str,
    },
}

#[derive(Debug)]
pub struct Model {
    pub id: &'static str,
    pub kind: Kind,
    pub name: &'static str,
    pub assets: &'static [Asset],
    pub recipe: Recipe,
}

#[cfg(test)]
const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";

macro_rules! release {
    ($path:literal) => {
        concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/",
            $path
        )
    };
}

pub static MODELS: &[Model] = &[
    Model {
        id: "moonshine-base",
        kind: Kind::Stt,
        name: "Moonshine base (English)",
        assets: &[Asset {
            url: release!("asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2"),
            sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891",
            size: 111_266_225,
            unpack: Unpack::TarBz2(&[
                "encoder_model.ort",
                "decoder_model_merged.ort",
                "tokens.txt",
                "LICENSE",
            ]),
        }],
        recipe: Recipe::Moonshine {
            encoder: "encoder_model.ort",
            merged_decoder: "decoder_model_merged.ort",
            tokens: "tokens.txt",
        },
    },
    Model {
        id: "whisper-base-en",
        kind: Kind::Stt,
        name: "Whisper base.en",
        assets: &[Asset {
            url: release!("asr-models/sherpa-onnx-whisper-base.en.tar.bz2"),
            sha256: "475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542",
            size: 208_576_005,
            unpack: Unpack::TarBz2(&[
                "base.en-encoder.int8.onnx",
                "base.en-decoder.int8.onnx",
                "base.en-tokens.txt",
            ]),
        }],
        recipe: Recipe::Whisper {
            encoder: "base.en-encoder.int8.onnx",
            decoder: "base.en-decoder.int8.onnx",
            tokens: "base.en-tokens.txt",
        },
    },
    Model {
        id: "parakeet",
        kind: Kind::Stt,
        name: "Parakeet TDT 0.6B v2 (English)",
        assets: &[Asset {
            url: release!("asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"),
            sha256: "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714",
            size: 482_440_461,
            unpack: Unpack::TarBz2(&[
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt",
            ]),
        }],
        recipe: Recipe::Transducer {
            encoder: "encoder.int8.onnx",
            decoder: "decoder.int8.onnx",
            joiner: "joiner.int8.onnx",
            tokens: "tokens.txt",
        },
    },
    Model {
        id: "kokoro",
        kind: Kind::Tts,
        name: "Kokoro (English)",
        assets: &[
            Asset {
                url: release!("tts-models/kokoro-int8-en-v0_19.tar.bz2"),
                sha256: "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
                size: 103_248_205,
                unpack: Unpack::TarBz2(&["model.int8.onnx", "voices.bin", "tokens.txt", "LICENSE"]),
            },
            Asset {
                url: release!("tts-models/lexicon-en-us.txt"),
                sha256: "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a",
                size: 6_305_773,
                unpack: Unpack::File("lexicon-en-us.txt"),
            },
        ],
        recipe: Recipe::Kokoro {
            model: "model.int8.onnx",
            voices: "voices.bin",
            tokens: "tokens.txt",
            lexicon: "lexicon-en-us.txt",
        },
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn is_stt(id: &str) -> bool {
    find(id).is_some_and(|m| m.kind == Kind::Stt)
}

impl Model {
    pub fn total_size(&self) -> u64 {
        self.assets.iter().map(|a| a.size).sum()
    }

    pub fn size_mb(&self) -> u64 {
        (self.total_size() + 500_000) / 1_000_000
    }

    /// Every file the model folder must hold once installed.
    pub fn files(&self) -> Vec<&'static str> {
        self.assets
            .iter()
            .flat_map(|a| match a.unpack {
                Unpack::TarBz2(names) => names.to_vec(),
                Unpack::File(name) => vec![name],
            })
            .collect()
    }

    pub fn dir(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.id)
    }

    pub fn installed(&self, models_dir: &Path) -> bool {
        let dir = self.dir(models_dir);
        self.files().iter().all(|f| dir.join(f).is_file())
    }
}

/// `<dataDir>/models`.
pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        let ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        assert_eq!(
            ids,
            ["moonshine-base", "whisper-base-en", "parakeet", "kokoro"]
        );
        for model in MODELS {
            assert!(!model.assets.is_empty());
            for asset in model.assets {
                assert!(asset.url.starts_with(RELEASES), "{}", asset.url);
                assert!(
                    asset.url.contains("/asr-models/") || asset.url.contains("/tts-models/"),
                    "{}",
                    asset.url
                );
                assert_eq!(asset.sha256.len(), 64);
                assert!(asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
                assert!(asset.size > 1_000_000);
            }
            // Every file the recipe uses is one the download keeps.
            let files = model.files();
            let used: Vec<&str> = match model.recipe {
                Recipe::Moonshine {
                    encoder,
                    merged_decoder,
                    tokens,
                } => vec![encoder, merged_decoder, tokens],
                Recipe::Whisper {
                    encoder,
                    decoder,
                    tokens,
                } => vec![encoder, decoder, tokens],
                Recipe::Transducer {
                    encoder,
                    decoder,
                    joiner,
                    tokens,
                } => vec![encoder, decoder, joiner, tokens],
                Recipe::Kokoro {
                    model,
                    voices,
                    tokens,
                    lexicon,
                } => vec![model, voices, tokens, lexicon],
            };
            for file in used {
                assert!(files.contains(&file), "{} needs {file}", model.id);
            }
            assert_eq!(
                matches!(model.recipe, Recipe::Kokoro { .. }),
                model.kind == Kind::Tts
            );
        }
    }

    #[test]
    fn lookups_and_sizes() {
        assert!(is_stt("moonshine-base"));
        assert!(is_stt("parakeet"));
        assert!(!is_stt("kokoro"));
        assert!(!is_stt("nope"));
        assert_eq!(find("moonshine-base").unwrap().size_mb(), 111);
        assert_eq!(find("kokoro").unwrap().size_mb(), 110);
        assert_eq!(
            find("kokoro").unwrap().files(),
            [
                "model.int8.onnx",
                "voices.bin",
                "tokens.txt",
                "LICENSE",
                "lexicon-en-us.txt"
            ]
        );
        // The settings default must be a real STT model.
        assert!(is_stt(&crate::settings::Settings::default().voice.stt));
    }

    #[test]
    fn installed_needs_every_file() {
        let tmp = tempfile::tempdir().unwrap();
        let model = find("moonshine-base").unwrap();
        assert!(!model.installed(tmp.path()));
        let dir = model.dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        for f in &model.files()[..3] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(!model.installed(tmp.path()), "LICENSE missing");
        std::fs::write(dir.join("LICENSE"), b"x").unwrap();
        assert!(model.installed(tmp.path()));
    }
}
