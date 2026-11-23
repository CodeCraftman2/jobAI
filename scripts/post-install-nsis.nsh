; JobAI sets up its Whisper venv and .env inside %APPDATA% on first launch,
; so the installer does not bootstrap them into the install directory.

; If the wizard is closed/cancelled or fails after file copying has begun, roll
; the partial install back so no half-installed app is left behind.

Var jobaiInstallStarted

; MUI's own .onUserAbort calls this; defining .onUserAbort directly would clash.
!define MUI_CUSTOMFUNCTION_ABORT JobAIRollbackInstall

!macro customHeader
  ; Runs before the main "install" section, so the flag is only set once
  ; the wizard has actually reached the install step.
  Section "-jobaiMarkInstallStarted"
    StrCpy $jobaiInstallStarted "1"
  SectionEnd

  Function JobAIRollbackInstall
    ${If} $jobaiInstallStarted != "1"
      Return
    ${EndIf}
    ; Never remove anything unless it is demonstrably a JobAI install dir.
    ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Return
    ${EndIf}
    SetDetailsPrint none
    SetOutPath $TEMP
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      ; _? keeps the uninstaller in place so ExecWait actually waits for it.
      ExecWait '"$INSTDIR\${UNINSTALL_FILENAME}" /S _?=$INSTDIR'
      Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    ${EndIf}
    RMDir /r "$INSTDIR"
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
  FunctionEnd

  Function .onInstFailed
    Call JobAIRollbackInstall
  FunctionEnd
!macroend

; The app's executable is Code.exe, the same name as VS Code's. The default
; check (taskkill /im Code.exe) would force-close VS Code too, so only a
; Code.exe running from this install folder counts as "the app is running".
!macro customCheckAppRunning
  ; WMI, not Get-Process: the (un)installer is 32-bit, and a 32-bit PowerShell
  ; cannot read the .Path of a 64-bit process, so nothing would ever match.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\${APP_EXECUTABLE_FILENAME}' }) { exit 0 } else { exit 1 }"`
  Pop $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK jobaiStopApp
      Quit
    ${endIf}
    jobaiStopApp:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\${APP_EXECUTABLE_FILENAME}' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1500"`
    Pop $R0
  ${endIf}
!macroend

!macro customInstall
!macroend

; Settings, API keys, the Whisper venv and models live in %APPDATA%\jobai.
; Left behind, a reinstall finds them and skips setup, so a real uninstall
; offers to remove them. Updates and silent runs (the rollback above) keep
; them. electron-builder's deleteAppDataOnUninstall is NOT used: it would
; also delete %APPDATA%\Code (the product name), which is VS Code's folder.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Electron keeps userData per user, also for an all-users install.
    SetShellVarContext current
    ${If} ${FileExists} "$APPDATA\jobai\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your JobAI settings, saved API keys, local Whisper install and downloaded models?$\r$\n$\r$\n($APPDATA\jobai)$\r$\n$\r$\nChoose Yes for a clean reinstall that runs setup again." /SD IDNO IDNO jobaiKeepData
        RMDir /r "$APPDATA\jobai"
      jobaiKeepData:
    ${EndIf}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
