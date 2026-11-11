//! The API key, kept in the OS credential store (Windows Credential Manager; Secret Service on
//! Linux, Keychain on macOS) under service `winku`, account `api-key`. It goes to the engine in
//! `configure` and never to the UI.

use keyring::Entry;

const SERVICE: &str = "winku";
const ACCOUNT: &str = "api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential store unavailable: {e}"))
}

/// The stored key, or None when there is none or the store can't be read.
pub fn get() -> Option<String> {
    match entry().and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        Ok(key) if !key.is_empty() => Some(key),
        _ => None,
    }
}

pub fn set(key: &str) -> Result<(), String> {
    entry()?
        .set_password(key)
        .map_err(|e| format!("could not save the key: {e}"))
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the key: {e}")),
    }
}

pub fn present() -> bool {
    get().is_some()
}
