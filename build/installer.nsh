; FolderBot 2.x installer hooks (one-click, per user).
;
; 1. FolderBot keeps running in the tray, and a hidden window does not answer the installer's
;    close request, so every hook force-closes it first.
; 2. FolderBot 1.x shipped assisted installers whose uninstallers were unreliable (1.0.21 and
;    earlier failed outright). Rather than run an old uninstaller, the installer removes a 1.x
;    install itself: its program folder, its registry entries and its shortcuts. Settings and
;    history in %APPDATA%\FolderBot are never touched. 2.x installs are upgraded the normal way.
; 3. Uninstalling asks whether to delete settings and history too. Updates never ask and never
;    delete them.

!macro killFolderBot
  DetailPrint "Closing FolderBot"
  nsExec::ExecToLog 'taskkill /F /T /IM "FolderBot.exe"'
  Pop $0
  Sleep 1000
!macroend

!macro removeLegacyInstall
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  StrCpy $R1 $R0 2
  ${If} $R1 == "1."
    DetailPrint "Removing FolderBot $R0"
    ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R2 != ""
    ${AndIf} ${FileExists} "$R2\FolderBot.exe"
      RMDir /r "$R2"
    ${EndIf}
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    Delete "$SMPROGRAMS\FolderBot.lnk"
    Delete "$DESKTOP\FolderBot.lnk"
  ${EndIf}
!macroend

; Replaces the installer's interactive "the app is running" prompt.
!macro customCheckAppRunning
  !insertmacro killFolderBot
!macroend

!macro customInit
  !insertmacro killFolderBot
  !insertmacro removeLegacyInstall
!macroend

; Runs at the start of the uninstaller, including the silent one an update triggers.
!macro customUnInit
  !insertmacro killFolderBot
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FolderBot"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "folderbot"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.folderbot.app"

  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your FolderBot settings and history?$\r$\n$\r$\nChoose No to keep them for a future install. Your media files are not affected either way." /SD IDNO IDNO keepUserData
      RMDir /r "$APPDATA\FolderBot"
      RMDir /r "$LOCALAPPDATA\folderbot-updater"
    keepUserData:
  ${endIf}
!macroend
