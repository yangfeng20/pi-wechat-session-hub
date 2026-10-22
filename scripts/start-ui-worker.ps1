$ErrorActionPreference = 'Stop'
if ($args.Count -ne 2) {
  exit 31
}
$managerDirectory = [System.IO.Path]::GetFullPath($args[0])
$launchId = $args[1]
if ($launchId -notmatch '^[a-fA-F0-9-]{36}$') {
  exit 32
}
$launchDirectory = Join-Path $managerDirectory 'launches'
$launchFile = Join-Path $launchDirectory ($launchId + '.json')
$record = Get-Content -LiteralPath $launchFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.schemaVersion -ne 1 -or $record.launchId -ne $launchId -or $record.managerDirectory -ne $managerDirectory) {
  exit 33
}
$env:PI_CODING_AGENT_DIR = $record.agentDirectory
$env:PI_WECHAT_MANAGER_DIR = $managerDirectory
$env:PI_WECHAT_MANAGER_LAUNCH_ID = $launchId
$env:PI_WECHAT_MANAGER_PIPE = $record.pipeEndpoint
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $record.nodeExecutable
$startInfo.WorkingDirectory = $record.projectPath
$startInfo.UseShellExecute = $false
$startInfo.ArgumentList.Add($record.piCliEntry)
$startInfo.ArgumentList.Add('--extension')
$startInfo.ArgumentList.Add($record.extensionPath)
if ($record.sessionName) {
  $startInfo.ArgumentList.Add('--name')
  $startInfo.ArgumentList.Add($record.sessionName)
}
if ($record.mode -eq 'resume') {
  $startInfo.ArgumentList.Add('--session')
  $startInfo.ArgumentList.Add($record.sessionFile)
}
$process = [System.Diagnostics.Process]::Start($startInfo)
$process.WaitForExit()
exit $process.ExitCode
