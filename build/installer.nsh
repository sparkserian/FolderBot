; FolderBot keeps running in the tray when launch-at-login is on, and a hidden window will
; not respond to the installer's close request. Every hook below force-closes the process
; instead of asking it politely, so an upgrade never stalls on "please close it manually".

!macro killFolderBot
  DetailPrint "Closing FolderBot"
  nsExec::ExecToLog 'taskkill /F /T /IM "FolderBot.exe"'
  Pop $0
  Sleep 1500
!macroend

; Replaces the installer's interactive "the app is running" prompt.
!macro customCheckAppRunning
  !insertmacro killFolderBot
!macroend

; Runs at the very start of the installer, before the old version is removed.
!macro preInit
  !insertmacro killFolderBot
!macroend

!macro customInit
  !insertmacro killFolderBot
!macroend

; Runs at the start of the uninstaller, including the silent one an upgrade triggers.
!macro customUnInit
  !insertmacro killFolderBot
!macroend

!macro customUnInstall
  DetailPrint "Removing FolderBot launch-at-login entries"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FolderBot"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "folderbot"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "FolderBot"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "folderbot"
!macroend
