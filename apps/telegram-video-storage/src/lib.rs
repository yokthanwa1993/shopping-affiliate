//! Library crate so unit and integration tests can reuse the same modules as
//! the binary. Keep the public surface narrow — anything not used by `main` or
//! tests stays `pub(crate)`.

pub mod config;
pub mod routes;
pub mod storage;
