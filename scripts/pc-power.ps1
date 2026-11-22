$ErrorActionPreference = 'Stop'
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /change monitor-timeout-ac 15
"power plan set: no sleep/hibernate on AC or battery; monitor off after 15 min"
