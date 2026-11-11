//! Secrets kept in the OS credential store (Windows Credential Manager; Secret Service on
//! Linux, Keychain on macOS) under service `winku`: the provider key (account `api-key`) and the
//! Brave Search key (account `search-api-key`). They go to the engine in `configure` and never
//! to the UI.

use keyring::Entry;

const SERVICE: &str = "winku";

/// A credential-store account Winku uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Account {
    /// The provider API key.
    ApiKey,
    /// The Brave Search API key (`web_search`).
    SearchApiKey,
}

impl Account {
    /// Reads the optional `account` argument of the secret commands; absent = the provider key.
    pub fn parse(account: Option<&str>) -> Result<Self, String> {
        match account {
            None | Some("api-key") => Ok(Account::ApiKey),
            Some("search-api-key") => Ok(Account::SearchApiKey),
            Some(other) => Err(format!("unknown secret account {other:?}")),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Account::ApiKey => "api-key",
            Account::SearchApiKey => "search-api-key",
        }
    }
}

fn entry(account: Account) -> Result<Entry, String> {
    Entry::new(SERVICE, account.name()).map_err(|e| format!("credential store unavailable: {e}"))
}

/// The stored key, or None when there is none or the store can't be read.
pub fn get(account: Account) -> Option<String> {
    match entry(account).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        Ok(key) if !key.is_empty() => Some(key),
        _ => None,
    }
}

pub fn set(account: Account, key: &str) -> Result<(), String> {
    entry(account)?
        .set_password(key)
        .map_err(|e| format!("could not save the key: {e}"))
}

pub fn clear(account: Account) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the key: {e}")),
    }
}

pub fn present(account: Account) -> bool {
    get(account).is_some()
}

#[cfg(test)]
mod tests {
    use super::Account;

    #[test]
    fn accounts_are_validated() {
        assert_eq!(Account::parse(None), Ok(Account::ApiKey));
        assert_eq!(Account::parse(Some("api-key")), Ok(Account::ApiKey));
        assert_eq!(
            Account::parse(Some("search-api-key")),
            Ok(Account::SearchApiKey)
        );
        assert!(Account::parse(Some("other")).is_err());
        assert!(Account::parse(Some("")).is_err());
    }
}
