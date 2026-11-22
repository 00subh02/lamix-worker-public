$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\DEVIL_LUFFY\Documents\Default Project\LAMIX CLI HUNTING'
$runner = Join-Path $ws 'scripts\run-bot-elevated.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName 'LamixCliBot' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
"installed LamixCliBot (RunLevel=Highest, AtLogOn, restart on failure)"
