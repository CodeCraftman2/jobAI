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

!macro customInstall
!macroend

!macro customUnInstall
!macroend
