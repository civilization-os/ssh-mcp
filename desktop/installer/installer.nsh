LangString SSH_MCP_STOPPING 1033 "Stopping existing SSH-MCP Desktop processes..."
LangString SSH_MCP_STOPPING 2052 "正在停止现有的 SSH-MCP Desktop 进程..."
LangString SSH_MCP_REMOVE_DATA 1033 "Do you also want to remove saved SSH profiles, encrypted credentials, settings, and logs?"
LangString SSH_MCP_REMOVE_DATA 2052 "是否同时删除已保存的 SSH 配置、加密凭据、应用设置和日志？"

!macro EnsureSshMcpProcessesStopped
  DetailPrint "$(SSH_MCP_STOPPING)"
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "SSH-MCP Desktop.exe" /T /F'
!macroend

!macro customInit
  !insertmacro EnsureSshMcpProcessesStopped
!macroend

!macro customUnInit
  !insertmacro EnsureSshMcpProcessesStopped
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "$(SSH_MCP_REMOVE_DATA)" IDNO keepUserData
    RMDir /r "$APPDATA\SSH-MCP Desktop"
  keepUserData:
!macroend
