$ErrorActionPreference = 'Continue'
Set-Location 'C:\Users\DEVIL_LUFFY\Documents\Default Project\LAMIX CLI HUNTING'
$log = 'C:\Users\DEVIL_LUFFY\AppData\Local\Temp\opencode\lamix-bot.log'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"=== bot start $(Get-Date -Format o) elevated=$admin ===" | Out-File -FilePath $log -Append
& node --env-file-if-exists=.env src/bot.js *>> $log
