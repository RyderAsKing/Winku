//! Model downloads: stream each asset over https into a temporary folder while hashing it, check
//! the pinned SHA-256, unpack only the files the model needs, then rename the folder into place.
//! Nothing is installed unless every asset arrived intact.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::models::{Model, Unpack};

/// At most this often for `download_progress`.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Opens a URL for reading. The real one is `Https`; tests serve bytes from memory.
pub trait Fetch {
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, String>;
}

/// ureq over https (SChannel and the Windows certificate store on Windows, rustls elsewhere);
/// follows the GitHub release redirect to its CDN.
pub struct Https;

fn tls() -> ureq::tls::TlsConfig {
    let builder = ureq::tls::TlsConfig::builder();
    #[cfg(windows)]
    let builder = builder
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier);
    builder.build()
}

impl Fetch for Https {
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, String> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls())
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            // A stalled connection fails instead of hanging the download forever.
            .timeout_per_read(Some(Duration::from_secs(60)))
            .user_agent(concat!("winku/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let response = agent.get(url).call().map_err(|e| e.to_string())?;
        Ok(Box::new(response.into_body().into_reader()))
    }
}

/// Downloads in flight, so each model downloads at most once at a time.
#[derive(Default)]
pub struct Downloads {
    active: Mutex<HashSet<String>>,
}

impl Downloads {
    /// True if this call claimed the model; false if it is already downloading.
    pub fn begin(&self, id: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string())
    }

    pub fn finish(&self, id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
    }
}

/// Turns bytes received into a throttled 0–1 fraction. Pure: callers pass the time.
#[derive(Debug)]
pub struct Progress {
    done: u64,
    total: u64,
    last: Option<Instant>,
}

impl Progress {
    pub fn new(total: u64) -> Self {
        Self {
            done: 0,
            total: total.max(1),
            last: None,
        }
    }

    /// Adds received bytes; returns a fraction to report if one is due. Never 1: that is sent
    /// only once the model is installed.
    pub fn advance(&mut self, bytes: u64, now: Instant) -> Option<f32> {
        self.done += bytes;
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
        {
            return None;
        }
        self.last = Some(now);
        Some(self.fraction())
    }

    pub fn fraction(&self) -> f32 {
        (self.done as f64 / self.total as f64).min(0.99) as f32
    }
}

#[derive(Debug, PartialEq)]
pub enum InstallError {
    /// Network or HTTP failure.
    Fetch(String),
    /// The bytes didn't match the pinned SHA-256.
    Checksum,
    /// Disk, archive or missing-file trouble.
    Disk(String),
}

impl InstallError {
    /// A plain message for the eyes.
    pub fn message(&self, model: &Model) -> String {
        match self {
            InstallError::Fetch(e) => format!(
                "Couldn't download {}. Check your internet connection and try again. ({e})",
                model.name
            ),
            InstallError::Checksum => format!(
                "The {} download was damaged (its checksum didn't match), so it wasn't installed. Try again.",
                model.name
            ),
            InstallError::Disk(e) => format!("Couldn't install {}: {e}", model.name),
        }
    }
}

fn disk(e: impl std::fmt::Display) -> InstallError {
    InstallError::Disk(e.to_string())
}

fn temp_dir(model: &Model, models_dir: &Path) -> PathBuf {
    models_dir.join(format!(".download-{}", model.id))
}

/// Downloads, checks and unpacks `model` into `models_dir/<id>`. `on_progress` gets throttled
/// fractions below 1.
pub fn install(
    model: &Model,
    models_dir: &Path,
    fetch: &dyn Fetch,
    on_progress: &mut dyn FnMut(f32),
) -> Result<(), InstallError> {
    let tmp = temp_dir(model, models_dir);
    let result = install_into(model, models_dir, &tmp, fetch, on_progress);
    let _ = fs::remove_dir_all(&tmp);
    result
}

fn install_into(
    model: &Model,
    models_dir: &Path,
    tmp: &Path,
    fetch: &dyn Fetch,
    on_progress: &mut dyn FnMut(f32),
) -> Result<(), InstallError> {
    if tmp.exists() {
        fs::remove_dir_all(tmp).map_err(disk)?;
    }
    let unpacked = tmp.join("unpacked");
    fs::create_dir_all(&unpacked).map_err(disk)?;
    let mut progress = Progress::new(model.total_size());

    for (n, asset) in model.assets.iter().enumerate() {
        let part = tmp.join(format!("asset-{n}.part"));
        let digest = download(fetch, asset.url, &part, &mut progress, on_progress)?;
        if !digest.eq_ignore_ascii_case(asset.sha256) {
            return Err(InstallError::Checksum);
        }
        match asset.unpack {
            Unpack::TarBz2(keep) => {
                unpack_tar_bz2(&part, &unpacked, keep)?;
                fs::remove_file(&part).map_err(disk)?;
            }
            Unpack::File(name) => fs::rename(&part, unpacked.join(name)).map_err(disk)?,
        }
    }
    if let Some(missing) = model
        .files()
        .into_iter()
        .find(|f| !unpacked.join(f).is_file())
    {
        return Err(InstallError::Disk(format!(
            "the download didn't contain {missing}"
        )));
    }
    let dest = model.dir(models_dir);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(disk)?;
    }
    fs::rename(&unpacked, &dest).map_err(disk)
}

/// Streams one URL to `path`, returning its SHA-256 as lowercase hex.
fn download(
    fetch: &dyn Fetch,
    url: &str,
    path: &Path,
    progress: &mut Progress,
    on_progress: &mut dyn FnMut(f32),
) -> Result<String, InstallError> {
    let mut reader = fetch.open(url).map_err(InstallError::Fetch)?;
    let mut out = BufWriter::new(File::create(path).map_err(disk)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(InstallError::Fetch(e.to_string())),
        };
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(disk)?;
        if let Some(fraction) = progress.advance(n as u64, Instant::now()) {
            on_progress(fraction);
        }
    }
    out.flush().map_err(disk)?;
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Extracts the regular files whose names are in `keep` (from any folder in the archive) into
/// `dest`, flat. Only names from `keep` are ever written, so archive paths can't escape `dest`.
fn unpack_tar_bz2(archive: &Path, dest: &Path, keep: &[&str]) -> Result<(), InstallError> {
    let file = File::open(archive).map_err(disk)?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let bad = |e: std::io::Error| InstallError::Disk(format!("couldn't unpack the download: {e}"));
    for entry in tar.entries().map_err(bad)? {
        let mut entry = entry.map_err(bad)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(bad)?.into_owned();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(name) = keep.iter().find(|k| **k == name) else {
            continue;
        };
        let mut out = BufWriter::new(File::create(dest.join(name)).map_err(disk)?);
        std::io::copy(&mut entry, &mut out).map_err(bad)?;
        out.flush().map_err(disk)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::models::{Asset, Kind, Recipe};
    use std::collections::HashMap;

    struct Memory(HashMap<String, Vec<u8>>);

    impl Fetch for Memory {
        fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, String> {
            self.0
                .get(url)
                .map(|b| Box::new(std::io::Cursor::new(b.clone())) as Box<dyn Read + Send>)
                .ok_or_else(|| "HTTP 404".to_string())
        }
    }

    fn tar_bz2(files: &[(&str, &[u8])]) -> Vec<u8> {
        let enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        let mut builder = tar::Builder::new(enc);
        for (path, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    /// A two-asset model (an archive and a plain file) and the server that hosts it.
    fn fixture(corrupt: bool) -> (&'static Model, Memory) {
        let archive = tar_bz2(&[
            ("pack/model.onnx", b"weights"),
            ("pack/tokens.txt", b"a 0\nb 1\n"),
            ("pack/test_wavs/0.wav", b"not kept"),
        ]);
        let lexicon = b"hello h e l o\n".to_vec();
        let archive_sha = hex(&Sha256::digest(&archive));
        let lexicon_sha = if corrupt {
            "0".repeat(64)
        } else {
            hex(&Sha256::digest(&lexicon))
        };
        let assets: &'static [Asset] = Box::leak(Box::new([
            Asset {
                url: "https://example.test/pack.tar.bz2",
                sha256: leak(archive_sha),
                size: archive.len() as u64,
                unpack: Unpack::TarBz2(&["model.onnx", "tokens.txt"]),
            },
            Asset {
                url: "https://example.test/lexicon.txt",
                sha256: leak(lexicon_sha),
                size: lexicon.len() as u64,
                unpack: Unpack::File("lexicon.txt"),
            },
        ]));
        let model = Box::leak(Box::new(Model {
            id: "test-model",
            kind: Kind::Tts,
            name: "Test voice",
            assets,
            recipe: Recipe::Supertonic {
                duration_predictor: "model.onnx",
                text_encoder: "model.onnx",
                vector_estimator: "model.onnx",
                vocoder: "model.onnx",
                tts_json: "tokens.txt",
                unicode_indexer: "tokens.txt",
                voice_style: "lexicon.txt",
            },
        }));
        let server = Memory(HashMap::from([
            ("https://example.test/pack.tar.bz2".to_string(), archive),
            ("https://example.test/lexicon.txt".to_string(), lexicon),
        ]));
        (model, server)
    }

    #[test]
    fn installs_only_the_needed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (model, server) = fixture(false);
        let mut fractions = Vec::new();
        install(model, tmp.path(), &server, &mut |f| fractions.push(f)).unwrap();
        let dir = model.dir(tmp.path());
        assert!(model.installed(tmp.path()));
        assert_eq!(fs::read(dir.join("tokens.txt")).unwrap(), b"a 0\nb 1\n");
        assert!(!dir.join("0.wav").exists());
        assert!(!dir.join("test_wavs").exists());
        assert!(
            !tmp.path().join(".download-test-model").exists(),
            "temp folder removed"
        );
        assert!(!fractions.is_empty());
        assert!(fractions.iter().all(|f| (0.0..1.0).contains(f)));
    }

    #[test]
    fn checksum_mismatch_installs_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (model, server) = fixture(true);
        let err = install(model, tmp.path(), &server, &mut |_| {}).unwrap_err();
        assert_eq!(err, InstallError::Checksum);
        assert!(err.message(model).contains("checksum"));
        assert!(!model.dir(tmp.path()).exists());
        assert!(!tmp.path().join(".download-test-model").exists());
    }

    #[test]
    fn network_failure_installs_nothing_and_keeps_an_old_install() {
        let tmp = tempfile::tempdir().unwrap();
        let (model, mut server) = fixture(false);
        install(model, tmp.path(), &server, &mut |_| {}).unwrap();
        server.0.remove("https://example.test/lexicon.txt");
        let err = install(model, tmp.path(), &server, &mut |_| {}).unwrap_err();
        assert!(matches!(err, InstallError::Fetch(ref e) if e.contains("404")));
        assert!(model.installed(tmp.path()), "the earlier install survives");
    }

    #[test]
    fn a_model_downloads_once_at_a_time() {
        let downloads = Downloads::default();
        assert!(downloads.begin("moonshine-base"));
        assert!(!downloads.begin("moonshine-base"));
        assert!(
            downloads.begin("supertonic"),
            "other models are independent"
        );
        assert!(downloads.is_active("moonshine-base"));
        downloads.finish("moonshine-base");
        assert!(!downloads.is_active("moonshine-base"));
        assert!(downloads.begin("moonshine-base"));
    }

    #[test]
    fn progress_is_throttled_and_stays_below_one() {
        let t0 = Instant::now();
        let mut p = Progress::new(1000);
        assert_eq!(p.advance(100, t0), Some(0.1));
        assert_eq!(p.advance(100, t0 + Duration::from_millis(50)), None);
        assert_eq!(p.advance(100, t0 + Duration::from_millis(100)), Some(0.3));
        assert_eq!(p.advance(5000, t0 + Duration::from_millis(300)), Some(0.99));
    }
}
