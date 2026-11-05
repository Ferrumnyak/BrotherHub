//! Сертификаты для mpv.
//!
//! mpv скачивает потоки по HTTPS через свою libcurl, а она проверяет
//! сертификаты по встроенному списку, а не по хранилищу Windows. Если
//! сертификат сайта подписан корнем, который есть только в Windows
//! (например, «Russian Trusted Root CA», который ставят для Госуслуг и банков —
//! им подписаны некоторые серверы VK Видео), mpv отказывается открывать
//! видео, хотя браузер и yt-dlp открывают его без проблем.
//!
//! Поэтому при запуске собираем общий файл: корневые сертификаты Mozilla
//! (`certs/mozilla-roots.pem` — тот же список, что у curl и Firefox) плюс
//! доверенные корни из хранилища Windows — и передаём его mpv через
//! `--tls-ca-file`. Проверка сертификатов при этом остаётся включённой.

use std::{path::PathBuf, sync::OnceLock};

use crate::logs;

const MOZILLA_ROOTS: &str = include_str!("../certs/mozilla-roots.pem");

/// Путь к файлу с сертификатами для mpv (создаётся один раз за запуск).
pub fn ca_bundle() -> Option<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(build).clone()
}

fn build() -> Option<PathBuf> {
    let dir = crate::tools::tools_dir()?;
    std::fs::create_dir_all(&dir).ok()?;

    let mut pem = pem_blocks(MOZILLA_ROOTS);
    let mozilla = pem.matches("-----BEGIN CERTIFICATE-----").count();
    let system = system_roots();
    for der in &system {
        pem.push_str(&to_pem(der));
    }

    let path = dir.join("ca-bundle.pem");
    match std::fs::write(&path, pem) {
        Ok(()) => {
            logs::info(format!(
                "сертификаты для mpv: {mozilla} Mozilla + {} из Windows → {}",
                system.len(),
                path.display()
            ));
            Some(path)
        }
        Err(e) => {
            logs::warn(format!("не удалось записать {}: {e}", path.display()));
            None
        }
    }
}

/// Только сами сертификаты, без комментариев.
fn pem_blocks(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line == "-----BEGIN CERTIFICATE-----" {
            inside = true;
        }
        if inside {
            out.push_str(line);
            out.push('\n');
        }
        if line == "-----END CERTIFICATE-----" {
            inside = false;
        }
    }
    out
}

/// Доверенные корневые сертификаты из хранилища Windows (DER).
#[cfg(windows)]
fn system_roots() -> Vec<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{
        CertCloseStore, CertEnumCertificatesInStore, CertOpenSystemStoreW, CERT_CONTEXT,
    };

    let mut certs = Vec::new();
    let name: Vec<u16> = "ROOT".encode_utf16().chain(Some(0)).collect();
    unsafe {
        // Хранилище «ROOT» текущего пользователя включает и корни всего компьютера.
        let store = CertOpenSystemStoreW(0, name.as_ptr());
        if store.is_null() {
            logs::warn("не удалось открыть хранилище сертификатов Windows");
            return certs;
        }
        let mut ctx: *const CERT_CONTEXT = std::ptr::null();
        loop {
            ctx = CertEnumCertificatesInStore(store, ctx);
            if ctx.is_null() {
                break;
            }
            let cert = &*ctx;
            if !cert.pbCertEncoded.is_null() && cert.cbCertEncoded > 0 {
                certs.push(
                    std::slice::from_raw_parts(cert.pbCertEncoded, cert.cbCertEncoded as usize)
                        .to_vec(),
                );
            }
        }
        CertCloseStore(store, 0);
    }
    certs
}

#[cfg(not(windows))]
fn system_roots() -> Vec<Vec<u8>> {
    Vec::new()
}

/// DER → PEM.
fn to_pem(der: &[u8]) -> String {
    let b64 = base64(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

fn base64(data: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ABC[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn mozilla_roots_are_present() {
        let pem = pem_blocks(MOZILLA_ROOTS);
        assert!(pem.matches("-----BEGIN CERTIFICATE-----").count() > 100);
        assert!(!pem.contains('#'));
    }
}
