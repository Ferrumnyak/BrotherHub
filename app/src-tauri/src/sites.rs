//! Сайты, которые yt-dlp открыть не может, но поток у них обычный.
//!
//! Ссылку на страницу превращаем в прямую ссылку на поток, а её mpv
//! играет сам, без yt-dlp. В комнату по-прежнему уходит ссылка на
//! страницу — каждый участник разбирает её у себя.
//!
//! Сейчас поддерживается телеканал «Ю» (u-tv.ru). Его плеер EdgePlayer
//! отдаёт обычный HLS без шифрования:
//! - на странице серии есть
//!   `data-edge-player="https://media.u-tv.ru/videos/<id>?..."`;
//! - сам поток лежит в `https://media.u-tv.ru/videos/<id>/master.m3u8`.

use std::time::Duration;

use reqwest::Url;

const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/// Нужно ли разбирать ссылку здесь, а не отдавать её yt-dlp.
pub fn handles(url: &str) -> bool {
    Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(is_utv_host))
        .unwrap_or(false)
}

/// Прямая ссылка на поток для mpv. `quality` — высота кадра
/// (`None` — авто, до 1080p).
pub async fn resolve(url: &str, quality: Option<u32>) -> Result<String, String> {
    let url = Url::parse(url.trim()).map_err(|_| "Не получилось разобрать ссылку".to_string())?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("Не удалось подготовить загрузку: {e}"))?;

    // Ссылка прямо на плеер — страницу качать не нужно.
    let player = match video_dir(&url) {
        Some(_) => url.clone(),
        None => {
            let page = fetch(&client, &url).await?;
            let found = edge_player_url(&page).ok_or(
                "На этой странице нет видео. Открой страницу конкретной серии \
                 (…/episodes/…), а не всей передачи",
            )?;
            url.join(&found)
                .map_err(|_| "На странице странная ссылка на видео".to_string())?
        }
    };
    let dir = video_dir(&player).ok_or("На странице странная ссылка на видео")?;
    let master = dir
        .join("master.m3u8")
        .map_err(|_| "Не получилось собрать ссылку на поток".to_string())?;

    let playlist = fetch(&client, &master).await?;
    if !playlist.starts_with("#EXTM3U") {
        return Err("Сайт отдал не видеопоток — возможно, видео сняли".into());
    }
    match pick_variant(&playlist, quality) {
        Some(uri) => master
            .join(&uri)
            .map(String::from)
            .map_err(|_| "В потоке странная ссылка на качество".to_string()),
        // Список без вариантов качества — это уже сам поток.
        None => Ok(master.into()),
    }
}

async fn fetch(client: &reqwest::Client, url: &Url) -> Result<String, String> {
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("Сайт не отвечает: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Сайт ответил ошибкой {}", response.status().as_u16()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("Не удалось загрузить страницу: {e}"))
}

fn is_utv_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "u-tv.ru" || host.ends_with(".u-tv.ru")
}

/// Папка видео на сервере плеера: `https://<домен>/videos/<id>/`.
fn video_dir(url: &Url) -> Option<Url> {
    if !url.host_str().is_some_and(is_utv_host) {
        return None;
    }
    let mut segments = url.path_segments()?;
    if segments.next()? != "videos" {
        return None;
    }
    let id = segments.next().filter(|id| !id.is_empty())?;
    let ok = id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return None;
    }
    let mut dir = url.clone();
    dir.set_path(&format!("/videos/{id}/"));
    dir.set_query(None);
    dir.set_fragment(None);
    Some(dir)
}

/// Значение `data-edge-player="…"` со страницы.
fn edge_player_url(html: &str) -> Option<String> {
    const ATTR: &str = "data-edge-player=";
    let rest = &html[html.find(ATTR)? + ATTR.len()..];
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let value = &rest[1..];
    let value = &value[..value.find(quote)?];
    let value = value.trim().replace("&amp;", "&");
    (!value.is_empty()).then_some(value)
}

/// Выбрать вариант качества из master-плейлиста HLS: самый чёткий не выше
/// `quality` строк (по умолчанию 1080), а если таких нет — самый низкий.
fn pick_variant(playlist: &str, quality: Option<u32>) -> Option<String> {
    let limit = quality.unwrap_or(1080);
    let mut variants: Vec<(u32, u64, String)> = Vec::new();
    let mut pending: Option<(u32, u64)> = None;
    for line in playlist.lines().map(str::trim) {
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let height = attr(attrs, "RESOLUTION")
                .and_then(|r| r.split('x').nth(1)?.parse().ok())
                .unwrap_or(0);
            let bandwidth = attr(attrs, "BANDWIDTH")
                .and_then(|b| b.parse().ok())
                .unwrap_or(0);
            pending = Some((height, bandwidth));
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some((height, bandwidth)) = pending.take() {
                variants.push((height, bandwidth, line.to_string()));
            }
        }
    }
    let fitting = variants
        .iter()
        .filter(|(h, _, _)| *h <= limit)
        .max_by_key(|(h, b, _)| (*h, *b));
    fitting
        .or_else(|| variants.iter().min_by_key(|(h, b, _)| (*h, *b)))
        .map(|(_, _, uri)| uri.clone())
}

/// Значение атрибута `NAME=value` в строке `#EXT-X-STREAM-INF`
/// (кавычки не поддерживаем — у RESOLUTION и BANDWIDTH их не бывает).
fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    attrs.split(',').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key.trim() == name).then_some(value.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1358000,RESOLUTION=832x468,FRAME-RATE=25.000,CODECS=\"avc1.4d401e,mp4a.40.2\"
index-s02490-v1-a1.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=6203000,RESOLUTION=1920x1080,FRAME-RATE=25.000,CODECS=\"avc1.640028,mp4a.40.2\"
index-s02484-v1-a1.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2828000,RESOLUTION=1280x720,FRAME-RATE=25.000,CODECS=\"avc1.64001f,mp4a.40.2\"
index-s02487-v1-a1.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=371000,RESOLUTION=428x240,FRAME-RATE=25.000,CODECS=\"avc1.42c015,mp4a.40.2\"
index-s02496-v1-a1.m3u8

#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=627474,RESOLUTION=1920x1080,CODECS=\"avc1.640028\",URI=\"iframes-s02484-v1-a1.m3u8\"
";

    #[test]
    fn recognises_utv_links() {
        assert!(handles("https://www.u-tv.ru/shows/mama-v-16/episodes/1896636/"));
        assert!(handles("https://media.u-tv.ru/videos/83914_abc?player_id=1"));
        assert!(!handles("https://www.youtube.com/watch?v=x"));
        assert!(!handles("https://notu-tv.ru/videos/1"));
    }

    #[test]
    fn finds_player_on_page() {
        let html = r#"<div id="gplayer" data-edge-player="https://media.u-tv.ru/videos/83914_linhdhApn5ym1vCc?player_id=1241&amp;ad_id=935&amp;extid=1663" data-entity-id="1"></div>"#;
        let found = edge_player_url(html).unwrap();
        assert_eq!(
            found,
            "https://media.u-tv.ru/videos/83914_linhdhApn5ym1vCc?player_id=1241&ad_id=935&extid=1663"
        );
        let dir = video_dir(&Url::parse(&found).unwrap()).unwrap();
        assert_eq!(dir.as_str(), "https://media.u-tv.ru/videos/83914_linhdhApn5ym1vCc/");
        assert!(edge_player_url("<html>нет плеера</html>").is_none());
    }

    #[test]
    fn show_page_is_not_a_video() {
        let show = Url::parse("https://www.u-tv.ru/shows/mama-v-16/").unwrap();
        assert!(video_dir(&show).is_none());
    }

    #[test]
    fn picks_quality() {
        assert_eq!(pick_variant(MASTER, None).unwrap(), "index-s02484-v1-a1.m3u8");
        assert_eq!(pick_variant(MASTER, Some(720)).unwrap(), "index-s02487-v1-a1.m3u8");
        assert_eq!(pick_variant(MASTER, Some(480)).unwrap(), "index-s02490-v1-a1.m3u8");
        // Ниже самого низкого — берём самый низкий.
        assert_eq!(pick_variant(MASTER, Some(144)).unwrap(), "index-s02496-v1-a1.m3u8");
        // Плейлист без вариантов.
        assert!(pick_variant("#EXTM3U\n#EXTINF:2.0,\nsegment-1.ts\n", None).is_none());
    }
}
