param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$HostName = "com.url_guard.processor"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonScript = Join-Path $ScriptDir "process_image.py"
$HostManifest = Join-Path $ScriptDir "$HostName.json"

@"
{
  "name": "$HostName",
  "description": "URL Guard Python image processor",
  "path": "$PythonScript",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@ | Set-Content -Encoding UTF8 $HostManifest

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegistryPath -Force | Out-Null
Set-ItemProperty -Path $RegistryPath -Name "(default)" -Value $HostManifest
Write-Host "Installed native host manifest: $HostManifest"
