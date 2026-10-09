use std::ffi::OsString;
use std::path::Path;

pub struct LaunchDirectory(pub Result<Option<String>, String>);

pub fn directory_argument(args: impl IntoIterator<Item = OsString>) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    let mut directory = None;
    while let Some(arg) = args.next() {
        if arg == "--working-directory" {
            if directory.is_some() { return Err("重复的目录启动参数".into()); }
            directory = Some(args.next().ok_or("缺少启动目录")?.into_string().map_err(|_| "启动目录编码无效")?);
        }
    }
    Ok(directory)
}

fn validate_directory(directory: String) -> Result<String, String> {
    let path = Path::new(&directory);
    if !path.is_absolute() || !path.is_dir() { return Err(format!("启动目录不存在或不是绝对目录: {directory}")); }
    Ok(directory)
}

impl LaunchDirectory {
    pub fn from_process() -> Self {
        Self(directory_argument(std::env::args_os().skip(1)).and_then(|directory| directory.map(validate_directory).transpose()))
    }
}

#[tauri::command]
pub fn get_launch_directory(window: tauri::WebviewWindow, state: tauri::State<'_, LaunchDirectory>) -> Result<Option<String>, String> {
    if window.label() != "main" { return Ok(None); }
    state.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_preserves_unicode_spaces_unc_and_trailing_backslashes() {
        for path in [r"C:\目录 空格\", r"\\server\share\目录 空格", r"D:\"] {
            assert_eq!(directory_argument(["--working-directory".into(), path.into()]).unwrap(), Some(path.into()));
        }
        assert_eq!(directory_argument([]).unwrap(), None);
        assert!(directory_argument(["--working-directory".into()]).is_err());
        assert!(directory_argument(["--working-directory".into(), "C:\\".into(), "--working-directory".into(), "D:\\".into()]).is_err());
    }
    #[test]
    fn startup_requires_an_existing_absolute_directory() {
        assert!(validate_directory(std::env::temp_dir().to_string_lossy().into_owned()).is_ok());
        assert!(validate_directory("relative-directory".into()).is_err());
        assert!(validate_directory(std::env::current_exe().unwrap().to_string_lossy().into_owned()).is_err());
    }
}
