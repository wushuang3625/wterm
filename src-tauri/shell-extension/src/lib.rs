#![cfg(windows)]
#![allow(non_snake_case)]

use std::{cell::RefCell, ffi::c_void, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
use windows::{
    core::{implement, Error, Interface, Ref, Result, BOOL, GUID, HRESULT, HSTRING, IUnknown, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HMODULE, S_FALSE, S_OK},
        System::{
            Com::{CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl, IServiceProvider},
            LibraryLoader::{GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT},
            Ole::{IObjectWithSite, IObjectWithSite_Impl},
            SystemServices::{SFGAO_FILESYSTEM, SFGAO_FOLDER},
        },
        UI::Shell::{IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IFolderView, IPersistFolder2, IShellBrowser, IShellItem, IShellItemArray, SHCreateItemFromIDList, SHStrDupW, ECS_DISABLED, ECS_ENABLED, ECF_DEFAULT, SID_STopLevelBrowser, SIGDN_FILESYSPATH},
    },
};

const COMMAND_ID: GUID = GUID::from_u128(0x92a65a7b_50e9_4c4f_92ab_6190cbfd6c11);
static OBJECTS: AtomicUsize = AtomicUsize::new(0);
static LOCKS: AtomicUsize = AtomicUsize::new(0);
struct ModuleLease;
impl ModuleLease { fn new() -> Self { OBJECTS.fetch_add(1, Ordering::SeqCst); Self } }
impl Drop for ModuleLease { fn drop(&mut self) { OBJECTS.fetch_sub(1, Ordering::SeqCst); } }

fn executable() -> Result<PathBuf> {
    unsafe {
        let mut module = HMODULE::default();
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(DllGetClassObject as *const () as *const u16), &mut module)?;
        let mut buffer = vec![0u16; 32768];
        let len = GetModuleFileNameW(Some(module), &mut buffer) as usize;
        if len == 0 || len >= buffer.len() { return Err(Error::from_win32()); }
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..len])).with_file_name("wterm.exe"))
    }
}

fn filesystem_path(item: &IShellItem) -> Result<String> {
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = name.to_string();
        CoTaskMemFree(Some(name.0.cast()));
        Ok(path?)
    }
}

#[implement(IExplorerCommand, IObjectWithSite)]
struct ExplorerCommand { site: RefCell<Option<IUnknown>>, _lease: ModuleLease }
impl ExplorerCommand {
    fn new() -> Self { Self { site: RefCell::new(None), _lease: ModuleLease::new() } }
    fn directory(&self, items: Option<&IShellItemArray>) -> Result<String> {
        unsafe {
            if let Some(items) = items {
                if items.GetCount()? > 0 { return filesystem_path(&items.GetItemAt(0)?); }
            }
            // Background commands receive the current folder via the Shell site.
            let site = self.site.borrow();
            let services = site.as_ref().ok_or_else(|| Error::from_hresult(E_NOINTERFACE))?.cast::<IServiceProvider>()?;
            // SID_SFolderView is IID_IFolderView (ShObjIdl_core.h). Explorer
            // provides it directly, including the modern background menu.
            let view: IFolderView = services.QueryService(&IFolderView::IID).or_else(|_| {
                let browser: IShellBrowser = services.QueryService(&SID_STopLevelBrowser)?;
                browser.QueryActiveShellView()?.cast::<IFolderView>()
            })?;
            let folder: IPersistFolder2 = view.GetFolder()?;
            let pidl = folder.GetCurFolder()?;
            let item = SHCreateItemFromIDList::<IShellItem>(pidl);
            CoTaskMemFree(Some(pidl.cast()));
            filesystem_path(&item?)
        }
    }
}
impl IExplorerCommand_Impl for ExplorerCommand_Impl {
    fn GetTitle(&self, _: Ref<'_, IShellItemArray>) -> Result<PWSTR> { unsafe { SHStrDupW(&HSTRING::from("在 wterm 中打开")) } }
    fn GetIcon(&self, _: Ref<'_, IShellItemArray>) -> Result<PWSTR> { unsafe { SHStrDupW(&HSTRING::from(format!("{},0", executable()?.display()))) } }
    fn GetToolTip(&self, _: Ref<'_, IShellItemArray>) -> Result<PWSTR> { unsafe { SHStrDupW(&HSTRING::from("从此目录启动 wterm 终端")) } }
    fn GetCanonicalName(&self) -> Result<GUID> { Ok(COMMAND_ID) }
    fn GetState(&self, items: Ref<'_, IShellItemArray>, _: BOOL) -> Result<u32> {
        // Only cached shell attributes on the menu-construction path, no disk IO.
        if let Some(items) = items.as_ref() {
            unsafe {
                if items.GetCount()? > 0 {
                    let attributes = items.GetItemAt(0)?.GetAttributes(SFGAO_FILESYSTEM | SFGAO_FOLDER)?;
                    return Ok(if attributes & (SFGAO_FILESYSTEM | SFGAO_FOLDER) == (SFGAO_FILESYSTEM | SFGAO_FOLDER) { ECS_ENABLED.0 as u32 } else { ECS_DISABLED.0 as u32 });
                }
            }
        }
        Ok(ECS_ENABLED.0 as u32)
    }
    fn Invoke(&self, items: Ref<'_, IShellItemArray>, _: Ref<'_, IBindCtx>) -> Result<()> {
        use std::os::windows::process::CommandExt;
        let directory = self.directory(items.as_ref())?;
        std::process::Command::new(executable()?).arg("--working-directory").arg(directory)
            .creation_flags(0x08000000).spawn().map_err(|error| Error::new(E_FAIL, error.to_string()))?;
        Ok(())
    }
    fn GetFlags(&self) -> Result<u32> { Ok(ECF_DEFAULT.0 as u32) }
    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> { Err(Error::from_hresult(E_NOTIMPL)) }
}
impl IObjectWithSite_Impl for ExplorerCommand_Impl {
    fn SetSite(&self, site: Ref<'_, IUnknown>) -> Result<()> { *self.site.borrow_mut() = site.cloned(); Ok(()) }
    fn GetSite(&self, iid: *const GUID, output: *mut *mut c_void) -> Result<()> {
        if iid.is_null() || output.is_null() { return Err(Error::from_hresult(E_POINTER)); }
        unsafe { *output = std::ptr::null_mut(); }
        let site = self.site.borrow();
        let site = site.as_ref().ok_or_else(|| Error::from_hresult(E_NOINTERFACE))?;
        unsafe { site.query(iid, output).ok() }
    }
}

#[implement(IClassFactory)]
struct Factory { _lease: ModuleLease }
impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<'_, IUnknown>, iid: *const GUID, output: *mut *mut c_void) -> Result<()> {
        if iid.is_null() || output.is_null() { return Err(Error::from_hresult(E_POINTER)); }
        unsafe { *output = std::ptr::null_mut(); }
        if !outer.is_null() { return Err(Error::from_hresult(CLASS_E_NOAGGREGATION)); }
        let command: IExplorerCommand = ExplorerCommand::new().into();
        unsafe { command.query(iid, output).ok() }
    }
    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() { LOCKS.fetch_add(1, Ordering::SeqCst); }
        else { let _ = LOCKS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| count.checked_sub(1)); }
        Ok(())
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(class: *const GUID, iid: *const GUID, output: *mut *mut c_void) -> HRESULT {
    if class.is_null() || iid.is_null() || output.is_null() { return E_POINTER; }
    *output = std::ptr::null_mut();
    if *class != COMMAND_ID { return CLASS_E_CLASSNOTAVAILABLE; }
    let factory: IClassFactory = Factory { _lease: ModuleLease::new() }.into();
    factory.query(iid, output)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECTS.load(Ordering::SeqCst) == 0 && LOCKS.load(Ordering::SeqCst) == 0 { S_OK } else { S_FALSE }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn class_factory_exposes_command_and_rejects_unknown_classes() {
        unsafe {
            let mut raw = std::ptr::null_mut();
            assert_eq!(DllGetClassObject(&GUID::zeroed(), &IClassFactory::IID, &mut raw), CLASS_E_CLASSNOTAVAILABLE);
            assert!(raw.is_null());
            DllGetClassObject(&COMMAND_ID, &IClassFactory::IID, &mut raw).ok().unwrap();
            let factory = IClassFactory::from_raw(raw);
            let command: IExplorerCommand = factory.CreateInstance(None).unwrap();
            let title = command.GetTitle(None).unwrap();
            assert_eq!(title.to_string().unwrap(), "在 wterm 中打开");
            CoTaskMemFree(Some(title.0.cast()));
            assert!(command.cast::<IObjectWithSite>().is_ok());
            // Exercise a real shell item, rather than just the menu getters.
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, SHCreateShellItemArrayFromShellItem};
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let directory = std::env::temp_dir();
            let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(directory.to_string_lossy().as_ref()), None).unwrap();
            let items: IShellItemArray = SHCreateShellItemArrayFromShellItem(&item).unwrap();
            assert_eq!(command.GetState(&items, false).unwrap(), ECS_ENABLED.0 as u32);
            assert_eq!(PathBuf::from(ExplorerCommand::new().directory(Some(&items)).unwrap()).canonicalize().unwrap(), directory.canonicalize().unwrap());
            let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(std::env::current_exe().unwrap().to_string_lossy().as_ref()), None).unwrap();
            let file: IShellItemArray = SHCreateShellItemArrayFromShellItem(&item).unwrap();
            assert_eq!(command.GetState(&file, false).unwrap(), ECS_DISABLED.0 as u32);
            drop(file); drop(item); drop(items);
            CoUninitialize();
            assert_eq!(DllCanUnloadNow(), S_FALSE);
            drop(command); drop(factory);
            assert_eq!(DllCanUnloadNow(), S_OK);
        }
    }
}
