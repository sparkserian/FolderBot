!macro customUnInit
  DetailPrint "Stopping FolderBot before uninstall"
  nsExec::ExecToLog 'taskkill /F /T /IM "FolderBot.exe"'
  Sleep 1000
!macroend

!macro customUnInstall
  DetailPrint "Removing FolderBot launch-at-login entries"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FolderBot"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "folderbot"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "FolderBot"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "folderbot"
!macroend
