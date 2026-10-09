//! Read-only verification of the COM class registered in the Windows package catalog.
use windows::{core::{Interface, Result, GUID, HSTRING}, Win32::{System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED}, UI::Shell::{IExplorerCommand, IShellItem, IShellItemArray, SHCreateItemFromParsingName, SHCreateShellItemArrayFromShellItem}}};

fn main() -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let result = verify();
        CoUninitialize();
        result
    }
}

unsafe fn verify() -> Result<()> {
    let command: IExplorerCommand = CoCreateInstance(&GUID::from_u128(0x92a65a7b_50e9_4c4f_92ab_6190cbfd6c11), None, CLSCTX_LOCAL_SERVER)?;
    let path = HSTRING::from(std::env::current_dir()?.to_string_lossy().as_ref());
    let item: IShellItem = SHCreateItemFromParsingName(&path, None)?;
    let items: IShellItemArray = SHCreateShellItemArrayFromShellItem(&item)?;
    let title = command.GetTitle(&items)?;
    let icon = command.GetIcon(&items)?;
    println!("Title: {}", title.to_string()?);
    println!("Icon: {}", icon.to_string()?);
    println!("State: {} (0 = enabled)", command.GetState(&items, false)?);
    CoTaskMemFree(Some(title.0.cast()));
    CoTaskMemFree(Some(icon.0.cast()));
    let _ = command.cast::<windows::Win32::System::Ole::IObjectWithSite>()?;
    Ok(())
}
