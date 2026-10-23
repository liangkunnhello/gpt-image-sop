//! dataUrl 解析：把 `data:image/png;base64,xxxx` 拆成 mime 与原始字节。
//!
//! 前端生成的成品图是 dataUrl 形式，落盘前要还原成二进制。
//! 不引 base64 库：只需要解码一种字母表，且大图也不大，手写够用。

/// 拆出 mime 与字节；不是 base64 形式的 dataUrl 返回 None
pub fn split(data_url: &str) -> Option<(String, Vec<u8>)> {
    let rest = data_url.strip_prefix("data:")?;
    let (head, payload) = rest.split_once(',')?;
    let mut parts = head.split(';');
    let mime = parts.next().unwrap_or("").trim();
    let is_base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !is_base64 {
        return None;
    }
    let bytes = decode(payload)?;
    let mime = if mime.is_empty() {
        "application/octet-stream".to_string()
    } else {
        mime.to_string()
    };
    Some((mime, bytes))
}

/// 标准字母表的 base64 解码，忽略空白与 padding
pub fn decode(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let v = value(byte)?;
        buffer = (buffer << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_known_value() {
        assert_eq!(decode("aGVsbG8=").unwrap(), b"hello".to_vec());
        assert!(decode("!!!").is_none());
    }

    #[test]
    fn splits_mime_and_bytes() {
        let (mime, bytes) = split("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello".to_vec());
    }

    #[test]
    fn rejects_non_base64() {
        assert!(split("data:text/plain,hello").is_none());
        assert!(split("http://example.com/a.png").is_none());
    }
}
