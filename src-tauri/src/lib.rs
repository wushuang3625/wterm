//! Tauri desktop application and terminal session services.
pub mod credentials;
pub mod events;
pub mod known_hosts;
pub mod profiles;
pub mod pty;
pub mod session;
pub mod settings;
pub mod sftp;
pub mod ssh;
pub mod ssh_agent;
pub mod ssh_auth;
pub mod ssh_route;
pub mod sshconfig;
pub mod state;
pub mod startup;
pub mod transfers;

mod webview;
mod windowing;
pub use webview::run;
