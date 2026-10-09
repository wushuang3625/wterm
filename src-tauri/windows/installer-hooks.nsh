!macro NSIS_HOOK_POSTINSTALL
  ; The NSIS process is x86; Sysnative bypasses WOW64 filesystem redirection.
  nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Register-ExplorerIntegration.ps1" -InstallationDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "wterm Explorer integration: $1"
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "wterm 已安装，但资源管理器菜单注册失败。需要受信任签名的身份包，或已启用的开发者模式。详情：$1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Register-ExplorerIntegration.ps1" -Remove'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "wterm Explorer integration removal: $1"
  ${EndIf}
!macroend
