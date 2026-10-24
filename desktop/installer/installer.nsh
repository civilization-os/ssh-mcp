LangString SSH_MCP_STOPPING 1033 "Stopping existing SSH-MCP Desktop processes..."
LangString SSH_MCP_STOPPING 2052 "正在停止现有的 SSH-MCP Desktop 进程..."

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
  ; Keep user configuration safe by default without intrusive prompts during re-installation/updates
!macroend
