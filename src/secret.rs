//! DPAPI-protected storage for the desktop sync bearer token.
//!
//! Plaintext never lands in `config.toml` on save after migration. The secret
//! lives in `%APPDATA%\clocked\token.dpapi`, encrypted to the current Windows
//! user (CryptProtectData / CryptUnprotectData).

use std::fs;
use std::path::PathBuf;
use std::ptr;

use windows::core::PWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

fn token_path() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("token.dpapi"))
}

/// Load the bearer token from DPAPI storage (empty if missing/unreadable).
pub fn load_token() -> String {
    let Some(path) = token_path() else {
        return String::new();
    };
    let Ok(bytes) = fs::read(&path) else {
        return String::new();
    };
    match unprotect(&bytes) {
        Ok(s) => s,
        Err(e) => {
            crate::logln!("token.dpapi unprotect failed: {e}");
            String::new()
        }
    }
}

/// Persist the bearer token with DPAPI. Empty token deletes the file.
pub fn save_token(token: &str) -> std::io::Result<()> {
    let path = token_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir")
    })?;
    if token.trim().is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let sealed = protect(token.trim()).map_err(|e| {
        std::io::Error::other(format!("DPAPI protect failed: {e}"))
    })?;
    fs::write(path, sealed)
}

fn protect(plain: &str) -> Result<Vec<u8>, String> {
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    unsafe {
        CryptProtectData(
            &mut input,
            PWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let out = slice.to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(out)
    }
}

fn unprotect(blob: &[u8]) -> Result<String, String> {
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    unsafe {
        CryptUnprotectData(
            &mut input,
            Some(ptr::null_mut()),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let s = String::from_utf8_lossy(slice).into_owned();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(s)
    }
}
