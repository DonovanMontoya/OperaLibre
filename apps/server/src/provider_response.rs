/// Bound untrusted provider bodies before allocating their JSON representation.
pub(crate) async fn read(mut response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    anyhow::ensure!(
        ![declared, response.content_length()]
            .into_iter()
            .flatten()
            .any(|size| size > limit as u64),
        "Provider response exceeds the size limit."
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            chunk.len() <= limit - bytes.len(),
            "Provider response exceeds the size limit."
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn bounds_declared_and_chunked_success_and_error_bodies() {
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .header("content-length", 33)
                .body("")
                .unwrap(),
        );
        assert!(super::read(response, 32).await.is_err());
        for status in [200, 500] {
            for length in [32, 33] {
                let stream = tokio_util::io::ReaderStream::with_capacity(
                    std::io::Cursor::new(vec![b'x'; length]),
                    7,
                );
                let response = reqwest::Response::from(
                    axum::http::Response::builder()
                        .status(status)
                        .body(reqwest::Body::wrap_stream(stream))
                        .unwrap(),
                );
                let result = super::read(response, 32).await;
                assert_eq!(result.is_ok(), length == 32);
            }
        }
    }
}
