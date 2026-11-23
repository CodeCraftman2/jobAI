; JobAI sets up its Whisper venv and .env in its data folder on first launch,
; so the installer does not bootstrap them into the install directory.
; The finish page only checks (scripts/check-speech-setup.ps1) and shows
; whether Python, Whisper and the model are already there.

; ── Data folder ──
; The data folder defaults to %APPDATA%\jobai. A fresh install offers a page
; to pick another one; the choice is a one-line pointer file,
; %APPDATA%\jobai\data-location.txt (UTF-16LE with a BOM), which the app reads
; at startup (src/core/data-location.js). Later moves are made in the app's
; Settings, which also copies the data.

Var jobaiPointerDir   ; the folder named in the pointer file, "" if none

; Reads the pointer into $jobaiPointerDir. Expects SetShellVarContext current.
!macro JobAIReadPointer
  Push $0
  Push $1
  Push $2
  StrCpy $jobaiPointerDir ""
  ClearErrors
  FileOpen $0 "$APPDATA\jobai\data-location.txt" r
  ${IfNot} ${Errors}
    FileReadWord $0 $1
    ${If} $1 = 65279
      FileReadUTF16LE $0 $jobaiPointerDir
    ${Else}
      FileSeek $0 0 SET
      FileRead $0 $jobaiPointerDir
    ${EndIf}
    FileClose $0
    ${Do}
      StrCpy $2 $jobaiPointerDir 1 -1
      ${If} $2 == "$\n"
      ${OrIf} $2 == "$\r"
        StrCpy $jobaiPointerDir $jobaiPointerDir -1
      ${Else}
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro JobAIRestoreShellContext
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

; A page after "Choose install location": where the data goes.
!macro customPageAfterChangeDir
  Var jobaiDataDir        ; chosen on this page; "" when the page was skipped
  Var jobaiDataDirError

  Function JobAIDataDirPre
    SetShellVarContext current
    ; Already set up (an update or reinstall): moving existing data is done in
    ; Settings, which copies it. Here it would only point at an empty folder.
    ${If} ${FileExists} "$APPDATA\jobai\data-location.txt"
    ${OrIf} ${FileExists} "$APPDATA\jobai\.env"
      StrCpy $jobaiDataDir ""
      !insertmacro JobAIRestoreShellContext
      Abort
    ${EndIf}
    ${If} $jobaiDataDir == ""
      StrCpy $jobaiDataDir "$APPDATA\jobai"
    ${EndIf}
    !insertmacro JobAIRestoreShellContext
  FunctionEnd

  Function JobAIDataDirShow
    ; "Space required" is the app's size, which says nothing about the data.
    Push $0
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1023
    ShowWindow $0 ${SW_HIDE}
    Pop $0
  FunctionEnd

  Function JobAIDataDirLeave
    Push $0
    Push $1
    Push $2
    StrCpy $jobaiDataDirError ""
    ; Drop a trailing backslash, but keep "X:\" as is.
    StrLen $0 $jobaiDataDir
    StrCpy $1 $jobaiDataDir 1 -1
    ${If} $0 > 3
    ${AndIf} $1 == "\"
      StrCpy $jobaiDataDir $jobaiDataDir -1
    ${EndIf}
    ; A full path: "X:\..." or "\\server\share\...".
    StrCpy $1 $jobaiDataDir 2 1
    StrCpy $2 $jobaiDataDir 2
    ${If} $1 != ":\"
    ${AndIf} $2 != "\\"
      StrCpy $jobaiDataDirError "Use a full path, for example X:\integration\jobai."
    ${EndIf}
    StrLen $0 $jobaiDataDir
    ${If} $jobaiDataDirError == ""
    ${AndIf} $0 <= 3
      StrCpy $jobaiDataDirError "Pick a folder, not a whole drive, for example X:\integration\jobai."
    ${EndIf}
    ; Not inside the install folder: updates replace it, uninstalling removes it.
    ${If} $jobaiDataDirError == ""
      StrCpy $2 "$INSTDIR\"
      StrLen $0 $2
      StrCpy $1 "$jobaiDataDir\" $0
      ${If} $1 == $2
        StrCpy $jobaiDataDirError "That folder is inside Termax's install folder ($INSTDIR), which updates replace and uninstalling removes. Pick another folder."
      ${EndIf}
    ${EndIf}
    ; Can it be created and written to?
    ${If} $jobaiDataDirError == ""
      ClearErrors
      CreateDirectory "$jobaiDataDir"
      FileOpen $0 "$jobaiDataDir\.jobai-write-test" w
      ${If} ${Errors}
        StrCpy $jobaiDataDirError "Termax cannot create or write to $jobaiDataDir. Pick a folder you can write to."
      ${Else}
        FileWrite $0 "test"
        FileClose $0
        Delete "$jobaiDataDir\.jobai-write-test"
      ${EndIf}
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
    ${If} $jobaiDataDirError != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$jobaiDataDirError"
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_HEADER_TEXT "Choose the data folder"
  !define MUI_PAGE_HEADER_SUBTEXT "Where Termax keeps its settings, API keys and speech models."
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Termax keeps its settings, saved API keys, the local Whisper install and its downloaded models in this folder. Whisper and a model can take a few GB, so pick a drive with room.$\r$\n$\r$\nYou can change it later in Termax's Settings (Data Folder), and test a folder there first."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Data folder"
  !define MUI_DIRECTORYPAGE_VARIABLE $jobaiDataDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE JobAIDataDirPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW JobAIDataDirShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE JobAIDataDirLeave
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

; Replaces electron-builder's finish page: same "Run Termax" checkbox, plus the
; local speech check. Silent installs skip pages, so they skip the check too.
!macro customFinishPage
  Var jobaiSpeechStatus

  Function JobAIFinishPre
    InitPluginsDir
    File "/oname=$PLUGINSDIR\check-speech-setup.ps1" "${PROJECT_DIR}\scripts\check-speech-setup.ps1"
    ; Whisper lives in the installing user's data folder: the one picked on
    ; the data-folder page, else the one an earlier install pointed at.
    SetShellVarContext current
    ${If} $jobaiDataDir != ""
      StrCpy $jobaiPointerDir $jobaiDataDir
    ${Else}
      !insertmacro JobAIReadPointer
      ${If} $jobaiPointerDir == ""
        StrCpy $jobaiPointerDir "$APPDATA\jobai"
      ${EndIf}
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=30000 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-speech-setup.ps1" -DataDir "$jobaiPointerDir"`
    Pop $0
    Pop $jobaiSpeechStatus
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    ${if} $0 != 0
      StrCpy $jobaiSpeechStatus "Could not check for Whisper here. Termax checks again when it starts."
    ${endif}
  FunctionEnd

  ; Same as electron-builder's own StartApp.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE JobAIFinishPre
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_FINISHPAGE_TEXT "$(^Name) is installed.$\r$\n$\r$\nLocal speech (Whisper):$\r$\n$jobaiSpeechStatus"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

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

; Only the app running from this install folder counts as "the app is running".
; The default check (taskkill /im by name) would also close any other program
; with the same executable name (the app was once Code.exe, like VS Code).
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

; Write the pointer for a data folder picked on the data-folder page.
!macro customInstall
  ${If} $jobaiDataDir != ""
    SetShellVarContext current
    ${If} $jobaiDataDir != "$APPDATA\jobai"
      Push $0
      CreateDirectory "$jobaiDataDir"
      CreateDirectory "$APPDATA\jobai"
      FileOpen $0 "$APPDATA\jobai\data-location.txt" w
      FileWriteWord $0 65279
      FileWriteUTF16LE $0 "$jobaiDataDir$\r$\n"
      FileClose $0
      Pop $0
    ${EndIf}
    !insertmacro JobAIRestoreShellContext
  ${EndIf}
!macroend

; Only Termax's own files in a data folder the user chose. That folder may be
; shared with other things (X:\integration, say), so it is never removed
; wholesale: what else is in it stays, and the folder goes only if empty.
!macro JobAIRemoveDataFiles DIR
  Delete "${DIR}\.env"
  Delete "${DIR}\secrets.enc.json"
  Delete "${DIR}\.jobai-firstrun-completed"
  Delete "${DIR}\model-health.json"
  Delete "${DIR}\Local State"
  Delete "${DIR}\Preferences"
  Delete "${DIR}\DevToolsActivePort"
  Delete "${DIR}\SharedStorage"
  Delete "${DIR}\lockfile"
  RMDir /r "${DIR}\.venv-whisper"
  RMDir /r "${DIR}\.whisper-models"
  RMDir /r "${DIR}\ocr"
  RMDir /r "${DIR}\Cache"
  RMDir /r "${DIR}\Code Cache"
  RMDir /r "${DIR}\GPUCache"
  RMDir /r "${DIR}\DawnCache"
  RMDir /r "${DIR}\DawnGraphiteCache"
  RMDir /r "${DIR}\DawnWebGPUCache"
  RMDir /r "${DIR}\GrShaderCache"
  RMDir /r "${DIR}\ShaderCache"
  RMDir /r "${DIR}\blob_storage"
  RMDir /r "${DIR}\Crashpad"
  RMDir /r "${DIR}\Network"
  RMDir /r "${DIR}\Shared Dictionary"
  RMDir /r "${DIR}\Session Storage"
  RMDir /r "${DIR}\Local Storage"
  RMDir "${DIR}"
!macroend

; Settings, API keys, the Whisper venv and models live in the data folder
; (%APPDATA%\jobai, or the folder its pointer names). Left behind, a
; reinstall finds them and skips setup, so a real uninstall offers to remove
; them. Updates and silent runs (the rollback above) keep them.
; electron-builder's deleteAppDataOnUninstall is NOT used: it would also
; delete %APPDATA%\Termax (named after the product), which is not where the
; data lives: main.js keeps it in %APPDATA%\jobai or the chosen folder.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Electron keeps userData per user, also for an all-users install.
    SetShellVarContext current
    !insertmacro JobAIReadPointer
    ${If} $jobaiPointerDir != ""
    ${AndIf} ${FileExists} "$jobaiPointerDir\*.*"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your JobAI settings, saved API keys, local Whisper install and downloaded models?$\r$\n$\r$\n($jobaiPointerDir)$\r$\n$\r$\nOnly Termax's own files are removed there; anything else in that folder stays.$\r$\n$\r$\nChoose Yes for a clean reinstall that runs setup again." /SD IDNO IDYES`
        !insertmacro JobAIRemoveDataFiles "$jobaiPointerDir"
        RMDir /r "$APPDATA\jobai"
      ${EndIf}
    ${ElseIf} ${FileExists} "$APPDATA\jobai\*.*"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your JobAI settings, saved API keys, local Whisper install and downloaded models?$\r$\n$\r$\n($APPDATA\jobai)$\r$\n$\r$\nChoose Yes for a clean reinstall that runs setup again." /SD IDNO IDYES`
        RMDir /r "$APPDATA\jobai"
      ${EndIf}
    ${EndIf}
    !insertmacro JobAIRestoreShellContext
  ${endIf}
!macroend
