; Compass NSIS installer hooks
; Called by Tauri's NSIS template at specific installation lifecycle points.
; All four macros must be present even if empty.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove all user data from AppData on uninstall so the next install starts clean.
  SetShellVarContext current
  RMDir /r "$APPDATA\com.compass.app"
!macroend
